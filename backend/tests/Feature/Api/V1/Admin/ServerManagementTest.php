<?php

namespace Tests\Feature\Api\V1\Admin;

use App\Enums\ServerAbility;
use App\Models\ServerAccess;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class ServerManagementTest extends TestCase
{
    use RefreshDatabase;

    private const AGENT_URL = 'http://agent.test';

    protected function setUp(): void
    {
        parent::setUp();

        config(['services.agent.url' => self::AGENT_URL, 'services.agent.token' => 'token']);
        Http::preventStrayRequests();
    }

    public function test_only_admins_manage_servers(): void
    {
        $user = User::factory()->create();
        ServerAccess::factory()->for($user)->abilities(ServerAbility::cases())->create();
        Sanctum::actingAs($user);

        $this->getJson(route('api.v1.admin.servers.defaults'))->assertForbidden();
        $this->postJson(route('api.v1.admin.servers.store'), $this->validServer())->assertForbidden();
        $this->patchJson(route('api.v1.admin.servers.update', 'alfa'), ['port' => 7778])->assertForbidden();
        $this->deleteJson(route('api.v1.admin.servers.destroy', 'alfa'))->assertForbidden();
        $this->postJson(route('api.v1.admin.servers.world.recreate', 'alfa'))->assertForbidden();

        Http::assertNothingSent();
    }

    public function test_creates_a_server(): void
    {
        Sanctum::actingAs(User::factory()->admin()->create());
        Http::fake([self::AGENT_URL.'/admin/servers' => Http::response(['data' => ['id' => 'nuovo', 'saveDir' => '/home/utente/tml-servers/nuovo']], 201)]);

        $this->postJson(route('api.v1.admin.servers.store'), $this->validServer())
            ->assertCreated()
            ->assertJsonPath('data.id', 'nuovo');

        Http::assertSent(fn (Request $request): bool => $request->method() === 'POST'
            && $request['port'] === 7778
            && $request['password'] === ''
            && $request['world'] === ['name' => 'Mondo Nuovo', 'size' => 2, 'difficulty' => 1, 'seed' => '']
            && $request['copyModsFrom'] === 'alfa');
    }

    public function test_validates_the_new_server(): void
    {
        Sanctum::actingAs(User::factory()->admin()->create());

        $this->postJson(route('api.v1.admin.servers.store'), [
            ...$this->validServer(),
            'id' => 'Nome Con Spazi',
            'port' => 80,
            'motd' => "due\nrighe",
            'world' => ['name' => '../evil', 'size' => 5, 'difficulty' => 1],
        ])
            ->assertUnprocessable()
            ->assertJsonValidationErrors(['id', 'port', 'motd', 'world.name', 'world.size']);

        Http::assertNothingSent();
    }

    public function test_agent_conflicts_are_returned_with_the_field(): void
    {
        Sanctum::actingAs(User::factory()->admin()->create());
        Http::fake([self::AGENT_URL.'/admin/servers' => Http::response([
            'error' => 'conflict', 'message' => 'La porta 7778 è già usata', 'details' => ['field' => 'port'],
        ], 409)]);

        $this->postJson(route('api.v1.admin.servers.store'), $this->validServer())
            ->assertConflict()
            ->assertJsonPath('details.field', 'port');
    }

    public function test_updates_settings_and_clears_the_password(): void
    {
        Sanctum::actingAs(User::factory()->admin()->create());
        Http::fake([self::AGENT_URL.'/admin/servers/alfa' => Http::response(['data' => ['hasPassword' => false]])]);

        $this->patchJson(route('api.v1.admin.servers.update', 'alfa'), ['password' => null, 'maxPlayers' => '10'])
            ->assertOk();

        Http::assertSent(fn (Request $request): bool => $request->method() === 'PATCH'
            && $request->data() === ['maxPlayers' => 10, 'password' => '']);
    }

    public function test_switches_the_server_to_another_installation(): void
    {
        Sanctum::actingAs(User::factory()->admin()->create());
        Http::fake([self::AGENT_URL.'/admin/servers/alfa' => Http::response(['data' => ['game' => 'tmodloader']])]);

        $this->patchJson(route('api.v1.admin.servers.update', 'alfa'), ['installDir' => '/srv/tmm-data/tmodloader/tModLoader'])
            ->assertOk()
            ->assertJsonPath('data.game', 'tmodloader');

        Http::assertSent(fn (Request $request): bool => $request->method() === 'PATCH'
            && $request->data() === ['installDir' => '/srv/tmm-data/tmodloader/tModLoader']);
    }

    public function test_recreates_the_world(): void
    {
        Sanctum::actingAs(User::factory()->admin()->create());
        Http::fake([self::AGENT_URL.'/admin/servers/alfa/world/recreate' => Http::response(['data' => ['trashed' => ['Alfa.wld']]])]);

        $this->postJson(route('api.v1.admin.servers.world.recreate', 'alfa'))
            ->assertOk()
            ->assertJsonPath('data.trashed.0', 'Alfa.wld');

        Http::assertSent(fn (Request $request): bool => $request->method() === 'POST');
    }

    public function test_the_world_of_a_running_server_is_not_recreated(): void
    {
        Sanctum::actingAs(User::factory()->admin()->create());
        Http::fake([self::AGENT_URL.'/admin/servers/alfa/world/recreate' => Http::response(['error' => 'conflict', 'message' => 'Spegni il server prima di ricreare il mondo'], 409)]);

        $this->postJson(route('api.v1.admin.servers.world.recreate', 'alfa'))->assertConflict();
    }

    public function test_removing_a_server_drops_its_permissions(): void
    {
        Sanctum::actingAs(User::factory()->admin()->create());
        $access = ServerAccess::factory()->for(User::factory())->abilities([ServerAbility::Console])->create();
        Http::fake([self::AGENT_URL.'/admin/servers/alfa' => Http::response(['data' => ['saveDir' => '/x']])]);

        $this->deleteJson(route('api.v1.admin.servers.destroy', 'alfa'))->assertOk();

        $this->assertModelMissing($access);
    }

    public function test_a_running_server_is_not_removed(): void
    {
        Sanctum::actingAs(User::factory()->admin()->create());
        $access = ServerAccess::factory()->for(User::factory())->abilities([ServerAbility::Console])->create();
        Http::fake([self::AGENT_URL.'/admin/servers/alfa' => Http::response(['error' => 'conflict', 'message' => 'Spegni il server prima di rimuoverlo'], 409)]);

        $this->deleteJson(route('api.v1.admin.servers.destroy', 'alfa'))->assertConflict();

        $this->assertModelExists($access);
    }

    /**
     * @return array<string, mixed>
     */
    private function validServer(): array
    {
        return [
            'id' => 'nuovo',
            'name' => 'Nuovo',
            'installDir' => '/home/utente/tModLoader',
            'port' => 7778,
            'maxPlayers' => 8,
            'password' => null,
            'motd' => null,
            'world' => ['name' => 'Mondo Nuovo', 'size' => 2, 'difficulty' => 1],
            'copyModsFrom' => 'alfa',
        ];
    }
}
