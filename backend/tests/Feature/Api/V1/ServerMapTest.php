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
            self::AGENT_URL.'/servers/alfa/map/livemap/sprites/tiles/700' => Http::response('PNG', 200, ['Content-Type' => 'image/png']),
            self::AGENT_URL.'/servers/alfa/map/world/sprites/treetops/2' => Http::response('PNG', 200, ['Content-Type' => 'image/png']),
        ]);

        $this->get(route('api.v1.servers.map.tiles', ['alfa', 'livemap', 2, 1, 'v' => 5]))
            ->assertOk()
            ->assertHeader('Content-Type', 'application/octet-stream')
            ->assertHeader('Cache-Control', 'immutable, max-age=31536000, private');
        $this->getJson(route('api.v1.servers.map.types', ['alfa', 'livemap', 'v' => 5]))->assertOk()->assertJsonPath('data.modTiles.700.mod', 'Foo');
        $this->get(route('api.v1.servers.map.sprite', ['alfa', 'livemap', 'tiles', 700]))->assertOk()->assertHeader('Content-Type', 'image/png');
        $this->get(route('api.v1.servers.map.sprite', ['alfa', 'world', 'treetops', 2]))->assertOk();

        $this->get('/api/v1/servers/alfa/map/livemap/sprites/altro/700')->assertNotFound();
        $this->get('/api/v1/servers/alfa/map/livemap/sprites/tiles/x')->assertNotFound();
        $this->get('/api/v1/servers/alfa/map/altro/tiles/0/0')->assertNotFound();
        Http::assertSentCount(4);
    }

    public function test_tile_data_requires_access_to_the_server(): void
    {
        Sanctum::actingAs(User::factory()->create());

        $this->get(route('api.v1.servers.map.tiles', ['alfa', 'world', 0, 0]))->assertForbidden();
        $this->get(route('api.v1.servers.map.sprite', ['alfa', 'livemap', 'tiles', 700]))->assertForbidden();

        Http::assertNothingSent();
    }

    public function test_world_editor_requires_the_console_ability(): void
    {
        $this->actingAsMember([]);

        $this->getJson(route('api.v1.servers.map.editor.catalog', 'alfa'))->assertForbidden();
        $this->postJson(route('api.v1.servers.map.editor.edit', 'alfa'), ['ops' => [['op' => 'kill-tile', 'x' => 1, 'y' => 2]]])->assertForbidden();

        Http::assertNothingSent();
    }

    public function test_world_editor_edits_are_validated_and_forwarded(): void
    {
        $this->actingAsMember([ServerAbility::Console]);
        Http::fake([
            self::AGENT_URL.'/servers/alfa/map/editor' => Http::response(['data' => ['applied' => 2, 'failed' => 0, 'failures' => []]]),
            self::AGENT_URL.'/servers/alfa/map/editor/catalog' => Http::response(['data' => ['format' => 1, 'tiles' => [['type' => 0, 'name' => 'Dirt']], 'walls' => []]]),
        ]);

        $this->postJson(route('api.v1.servers.map.editor.edit', 'alfa'), ['ops' => [['op' => 'explode', 'x' => 1, 'y' => 2]]])->assertUnprocessable();
        $this->postJson(route('api.v1.servers.map.editor.edit', 'alfa'), ['ops' => []])->assertUnprocessable();

        $this->postJson(route('api.v1.servers.map.editor.edit', 'alfa'), ['ops' => [
            ['op' => 'place-tile', 'x' => 10, 'y' => 20, 'type' => 1],
            ['op' => 'kill-wall', 'x' => 11, 'y' => 20],
        ]])->assertOk()->assertJsonPath('data.applied', 2);
        $this->getJson(route('api.v1.servers.map.editor.catalog', 'alfa'))->assertOk()->assertJsonPath('data.tiles.0.name', 'Dirt');

        Http::assertSent(fn (Request $request): bool => $request->method() === 'POST'
            && $request->url() === self::AGENT_URL.'/servers/alfa/map/editor'
            && $request->data() === ['ops' => [['op' => 'place-tile', 'x' => 10, 'y' => 20, 'type' => 1], ['op' => 'kill-wall', 'x' => 11, 'y' => 20]]]);
    }

    public function test_world_editor_errors_from_the_agent_are_passed_on(): void
    {
        $this->actingAsMember([ServerAbility::Console]);
        Http::fake([self::AGENT_URL.'/servers/alfa/map/editor' => Http::response(['error' => 'conflict', 'message' => 'Editor non disponibile'], 409)]);

        $this->postJson(route('api.v1.servers.map.editor.edit', 'alfa'), ['ops' => [['op' => 'kill-tile', 'x' => 1, 'y' => 2]]])
            ->assertConflict()
            ->assertJsonPath('message', 'Editor non disponibile');
    }

    public function test_world_edits_are_undone_through_the_agent(): void
    {
        $id = '1763650000000-0123abcd-4567-89ab-cdef-0123456789ab';
        $this->actingAsMember([]);
        $this->postJson(route('api.v1.servers.map.editor.undo', 'alfa'), ['id' => $id])->assertForbidden();

        $this->actingAsMember([ServerAbility::Console]);
        Http::fake([self::AGENT_URL.'/servers/alfa/map/editor/undo' => Http::response(['data' => ['applied' => 9, 'failed' => 0, 'failures' => []]])]);

        $this->postJson(route('api.v1.servers.map.editor.undo', 'alfa'), ['id' => '../x'])->assertUnprocessable();
        $this->postJson(route('api.v1.servers.map.editor.undo', 'alfa'), ['id' => $id])->assertOk()->assertJsonPath('data.applied', 9);

        Http::assertSent(fn (Request $request): bool => $request->url() === self::AGENT_URL.'/servers/alfa/map/editor/undo' && $request->data() === ['id' => $id]);
        Http::assertSentCount(1);
    }

    public function test_world_settings_require_the_console_ability(): void
    {
        $this->actingAsMember([]);

        $this->getJson(route('api.v1.servers.map.editor.world', 'alfa'))->assertForbidden();
        $this->postJson(route('api.v1.servers.map.editor.settings', 'alfa'), ['rain' => true])->assertForbidden();

        Http::assertNothingSent();
    }

    public function test_world_settings_are_read_and_changed_through_the_agent(): void
    {
        $this->actingAsMember([ServerAbility::Console]);
        Http::fake([
            self::AGENT_URL.'/servers/alfa/map/editor/world' => Http::response(['data' => ['clock' => 720, 'day' => true, 'rain' => false]]),
            self::AGENT_URL.'/servers/alfa/map/editor/settings' => Http::response(['data' => ['applied' => 1, 'failed' => 0, 'failures' => []]]),
        ]);

        $this->getJson(route('api.v1.servers.map.editor.world', 'alfa'))->assertOk()->assertJsonPath('data.clock', 720);

        $this->postJson(route('api.v1.servers.map.editor.settings', 'alfa'), [])->assertUnprocessable();
        $this->postJson(route('api.v1.servers.map.editor.settings', 'alfa'), ['clock' => 1440])->assertUnprocessable();
        $this->postJson(route('api.v1.servers.map.editor.settings', 'alfa'), ['gameMode' => 3])->assertUnprocessable();
        $this->postJson(route('api.v1.servers.map.editor.settings', 'alfa'), ['spawn' => ['x' => 1]])->assertUnprocessable();

        $this->postJson(route('api.v1.servers.map.editor.settings', 'alfa'), [
            'rain' => true,
            'spawn' => ['x' => 100, 'y' => 200],
            'bosses' => ['plantera' => true],
            'ignored' => 'x',
        ])->assertOk()->assertJsonPath('data.applied', 1);

        Http::assertSent(fn (Request $request): bool => $request->method() === 'POST'
            && $request->url() === self::AGENT_URL.'/servers/alfa/map/editor/settings'
            && $request->data() === ['rain' => true, 'spawn' => ['x' => 100, 'y' => 200], 'bosses' => ['plantera' => true]]);
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
