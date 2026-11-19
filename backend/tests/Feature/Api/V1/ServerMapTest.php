<?php

namespace Tests\Feature\Api\V1;

use App\Enums\ServerAbility;
use App\Models\ServerAccess;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class ServerMapTest extends TestCase
{
    use RefreshDatabase;

    private const AGENT_URL = 'http://agent.test';

    protected function setUp(): void
    {
        parent::setUp();

        config(['services.agent.url' => self::AGENT_URL, 'services.agent.token' => 'token']);
        Http::preventStrayRequests();
    }

    public function test_map_requires_access_to_the_server(): void
    {
        Sanctum::actingAs(User::factory()->create());

        $this->getJson(route('api.v1.servers.map.show', 'alfa'))->assertForbidden();
        $this->get(route('api.v1.servers.map.chunk', ['alfa', 'world', 1, 2]))->assertForbidden();

        Http::assertNothingSent();
    }

    public function test_map_state_passes_the_watching_flag(): void
    {
        $this->actingAsMember([]);
        Http::fake([self::AGENT_URL.'/servers/alfa/map*' => Http::response(['data' => ['source' => 'livemap', 'unavailable' => null]])]);

        $this->getJson(route('api.v1.servers.map.show', ['alfa', 'watching' => 1]))
            ->assertOk()
            ->assertJsonPath('data.source', 'livemap');

        Http::assertSent(fn (Request $request): bool => $request->url() === self::AGENT_URL.'/servers/alfa/map?watching=1');
    }

    public function test_chunks_are_images_cached_by_the_browser(): void
    {
        $this->actingAsMember([]);
        Http::fake([self::AGENT_URL.'/servers/alfa/map/livemap/chunks/3/1' => Http::response('PNG', 200, ['Content-Type' => 'image/png'])]);

        $this->get(route('api.v1.servers.map.chunk', ['alfa', 'livemap', 3, 1, 'v' => 123]))
            ->assertOk()
            ->assertHeader('Content-Type', 'image/png')
            ->assertHeader('Cache-Control', 'immutable, max-age=31536000, private');
    }

    public function test_chunk_source_and_coordinates_are_validated(): void
    {
        $this->actingAsMember([]);

        $this->get('/api/v1/servers/alfa/map/world/chunks/x/1')->assertNotFound();
        $this->get('/api/v1/servers/alfa/map/altro/chunks/1/1')->assertNotFound();

        Http::assertNothingSent();
    }

    public function test_tile_data_types_and_sprites_are_proxied_and_cached(): void
    {
        $this->actingAsMember([]);
        Http::fake([
            self::AGENT_URL.'/servers/alfa/map/livemap/tiles/2/1' => Http::response("\x1f\x8bdati", 200, ['Content-Type' => 'application/octet-stream']),
            self::AGENT_URL.'/servers/alfa/map/livemap/types' => Http::response(['data' => ['format' => 1, 'modTiles' => ['700' => ['mod' => 'Foo', 'name' => 'Bar', 'texture' => 'Foo/Tiles/Bar']]]]),
            self::AGENT_URL.'/servers/alfa/map/sprites/tiles/700' => Http::response('PNG', 200, ['Content-Type' => 'image/png']),
        ]);

        $this->get(route('api.v1.servers.map.tiles', ['alfa', 2, 1, 'v' => 5]))
            ->assertOk()
            ->assertHeader('Content-Type', 'application/octet-stream')
            ->assertHeader('Cache-Control', 'immutable, max-age=31536000, private');
        $this->getJson(route('api.v1.servers.map.types', ['alfa', 'v' => 5]))->assertOk()->assertJsonPath('data.modTiles.700.mod', 'Foo');
        $this->get(route('api.v1.servers.map.sprite', ['alfa', 'tiles', 700]))->assertOk()->assertHeader('Content-Type', 'image/png');

        $this->get('/api/v1/servers/alfa/map/sprites/altro/700')->assertNotFound();
        $this->get('/api/v1/servers/alfa/map/sprites/tiles/x')->assertNotFound();
        Http::assertSentCount(3);
    }

    public function test_tile_data_requires_access_to_the_server(): void
    {
        Sanctum::actingAs(User::factory()->create());

        $this->get(route('api.v1.servers.map.tiles', ['alfa', 0, 0]))->assertForbidden();
        $this->get(route('api.v1.servers.map.sprite', ['alfa', 'tiles', 700]))->assertForbidden();

        Http::assertNothingSent();
    }

    /**
     * @param  list<ServerAbility>  $abilities
     */
    private function actingAsMember(array $abilities): void
    {
        $user = User::factory()->create();
        ServerAccess::factory()->for($user)->abilities($abilities)->create();
        Sanctum::actingAs($user);
    }
}
