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

class ServerTrashTest extends TestCase
{
    use RefreshDatabase;

    private const AGENT_URL = 'http://agent.test';

    private const ITEM = '1793732707919-a087838d';

    protected function setUp(): void
    {
        parent::setUp();

        config(['services.agent.url' => self::AGENT_URL, 'services.agent.token' => 'token']);
        Http::preventStrayRequests();
    }

    public function test_trash_requires_files_or_mods_ability(): void
    {
        $this->actingAsMember([ServerAbility::Console]);

        $this->getJson(route('api.v1.servers.trash.index', 'alfa'))->assertForbidden();
        $this->postJson(route('api.v1.servers.trash.restore', ['alfa', self::ITEM]))->assertForbidden();
        $this->deleteJson(route('api.v1.servers.trash.clear', 'alfa'))->assertForbidden();

        Http::assertNothingSent();
    }

    public function test_only_the_kinds_allowed_by_the_abilities_are_requested(): void
    {
        $this->actingAsMember([ServerAbility::Files]);
        Http::fake([self::AGENT_URL.'/servers/alfa/trash*' => Http::response(['data' => [['id' => self::ITEM, 'kind' => 'file', 'daysLeft' => 30]]])]);

        $this->getJson(route('api.v1.servers.trash.index', 'alfa'))
            ->assertOk()
            ->assertJsonPath('data.0.daysLeft', 30);

        Http::assertSent(fn (Request $request): bool => $request->url() === self::AGENT_URL.'/servers/alfa/trash?kinds=file');
    }

    public function test_restore_passes_kinds_and_overwrite(): void
    {
        $this->actingAsMember([ServerAbility::Files, ServerAbility::Mods]);
        Http::fake([self::AGENT_URL.'/servers/alfa/trash/*' => Http::response(['data' => ['replaced' => true]])]);

        $this->postJson(route('api.v1.servers.trash.restore', ['alfa', self::ITEM]), ['overwrite' => true])
            ->assertOk()
            ->assertJsonPath('data.replaced', true);

        Http::assertSent(fn (Request $request): bool => $request->method() === 'POST'
            && $request->url() === self::AGENT_URL.'/servers/alfa/trash/'.self::ITEM.'/restore?kinds=file%2Cmod&overwrite=1');
    }

    public function test_conflicts_from_the_agent_are_returned(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);
        Http::fake([self::AGENT_URL.'/servers/alfa/trash/*' => Http::response(['error' => 'conflict', 'message' => 'La mod "X" è già installata'], 409)]);

        $this->postJson(route('api.v1.servers.trash.restore', ['alfa', self::ITEM]))
            ->assertConflict()
            ->assertJsonPath('message', 'La mod "X" è già installata');
    }

    public function test_delete_and_empty(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);
        Http::fake([self::AGENT_URL.'/servers/alfa/trash*' => Http::response(['data' => ['removed' => 2]])]);

        $this->deleteJson(route('api.v1.servers.trash.destroy', ['alfa', self::ITEM]))->assertNoContent();
        $this->deleteJson(route('api.v1.servers.trash.clear', 'alfa'))->assertOk()->assertJsonPath('data.removed', 2);

        Http::assertSent(fn (Request $request): bool => $request->method() === 'DELETE'
            && $request->url() === self::AGENT_URL.'/servers/alfa/trash/'.self::ITEM.'?kinds=mod');
        Http::assertSent(fn (Request $request): bool => $request->method() === 'DELETE'
            && $request->url() === self::AGENT_URL.'/servers/alfa/trash?kinds=mod');
    }

    public function test_invalid_item_ids_do_not_match_the_route(): void
    {
        $this->actingAsMember([ServerAbility::Files]);

        $this->postJson('/api/v1/servers/alfa/trash/..%2F..%2Fetc/restore')->assertNotFound();
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
