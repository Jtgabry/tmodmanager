<?php

namespace Tests\Feature\Api\V1;

use App\Enums\ServerAbility;
use App\Models\ServerAccess;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

class ServerApiTest extends TestCase
{
    use RefreshDatabase;

    private const AGENT_URL = 'http://agent.test';

    private const AGENT_TOKEN = 'test-agent-token';

    protected function setUp(): void
    {
        parent::setUp();

        config([
            'services.agent.url' => self::AGENT_URL,
            'services.agent.token' => self::AGENT_TOKEN,
        ]);

        Http::preventStrayRequests();
    }

    public function test_guests_cannot_access_servers(): void
    {
        $this->getJson(route('api.v1.servers.index'))->assertUnauthorized();
        $this->postJson(route('api.v1.servers.power', ['server' => 'alfa', 'action' => 'stop']))->assertUnauthorized();

        Http::assertNothingSent();
    }

    public function test_index_returns_servers_reported_by_the_agent(): void
    {
        $this->actingAsUser();
        Http::fake([self::AGENT_URL.'/servers' => Http::response(['data' => [$this->agentServer()]])]);

        $this->getJson(route('api.v1.servers.index'))
            ->assertOk()
            ->assertJsonPath('data.0.id', 'alfa')
            ->assertJsonPath('data.0.state', 'running')
            ->assertJsonPath('data.0.players', ['online' => 1, 'max' => 8])
            ->assertJsonMissingPath('data.0.screenSession');

        Http::assertSent(fn (Request $request): bool => $request->hasHeader('Authorization', 'Bearer '.self::AGENT_TOKEN));
    }

    public function test_show_returns_a_single_server(): void
    {
        $this->actingAsUser();
        Http::fake([self::AGENT_URL.'/servers/alfa' => Http::response(['data' => $this->agentServer()])]);

        $this->getJson(route('api.v1.servers.show', 'alfa'))
            ->assertOk()
            ->assertJsonPath('data.tmlVersion', '2026.09.3.1')
            ->assertJsonPath('data.game', 'tmodloader')
            ->assertJsonPath('data.version', '2026.09.3.1');
    }

    public function test_show_returns_a_vanilla_server(): void
    {
        $this->actingAsUser();
        Http::fake([self::AGENT_URL.'/servers/alfa' => Http::response(['data' => $this->agentServer([
            'game' => 'terraria', 'version' => '1.4.5.8', 'tmlVersion' => null,
        ])])]);

        $this->getJson(route('api.v1.servers.show', 'alfa'))
            ->assertOk()
            ->assertJsonPath('data.game', 'terraria')
            ->assertJsonPath('data.version', '1.4.5.8')
            ->assertJsonPath('data.tmlVersion', null);
    }

    public function test_show_returns_not_found_when_the_agent_does_not_know_the_server(): void
    {
        $this->actingAsUser();
        Http::fake([self::AGENT_URL.'/servers/missing' => Http::response(['error' => 'not_found', 'message' => 'Server "missing" non trovato'], 404)]);

        $this->getJson(route('api.v1.servers.show', 'missing'))
            ->assertNotFound()
            ->assertJson(['error' => 'not_found', 'message' => 'Server "missing" non trovato']);
    }

    #[DataProvider('powerActions')]
    public function test_power_actions_are_forwarded_to_the_agent(string $action): void
    {
        $this->actingAsUser();
        Http::fake([self::AGENT_URL."/servers/alfa/{$action}" => Http::response(['data' => $this->agentServer(['operation' => $action])], 202)]);

        $this->postJson(route('api.v1.servers.power', ['server' => 'alfa', 'action' => $action]))
            ->assertAccepted()
            ->assertJsonPath('data.operation', $action);

        Http::assertSent(fn (Request $request): bool => $request->method() === 'POST'
            && $request->url() === self::AGENT_URL."/servers/alfa/{$action}");
    }

    /**
     * @return array<string, array{string}>
     */
    public static function powerActions(): array
    {
        return ['start' => ['start'], 'stop' => ['stop'], 'restart' => ['restart']];
    }

    public function test_unknown_power_action_is_not_routed(): void
    {
        $this->actingAsUser();

        $this->postJson('/api/v1/servers/alfa/delete')->assertNotFound();

        Http::assertNothingSent();
    }

    public function test_invalid_server_id_is_not_routed(): void
    {
        $this->actingAsUser();

        $this->getJson('/api/v1/servers/..%2F..%2Fetc')->assertNotFound();

        Http::assertNothingSent();
    }

    public function test_agent_conflicts_are_returned_to_the_client(): void
    {
        $this->actingAsUser();
        Http::fake([self::AGENT_URL.'/servers/alfa/start' => Http::response(['error' => 'conflict', 'message' => 'Il server è già acceso'], 409)]);

        $this->postJson(route('api.v1.servers.power', ['server' => 'alfa', 'action' => 'start']))
            ->assertConflict()
            ->assertJson(['error' => 'conflict', 'message' => 'Il server è già acceso']);
    }

    public function test_unreachable_agent_returns_service_unavailable(): void
    {
        $this->actingAsUser();
        Http::fake([self::AGENT_URL.'/*' => Http::failedConnection()]);

        $this->getJson(route('api.v1.servers.index'))
            ->assertServiceUnavailable()
            ->assertJsonPath('error', 'agent_unavailable');
    }

    public function test_agent_rejecting_the_token_returns_bad_gateway(): void
    {
        $this->actingAsUser();
        Http::fake([self::AGENT_URL.'/*' => Http::response(['error' => 'unauthorized'], 401)]);

        $this->getJson(route('api.v1.servers.index'))
            ->assertStatus(502)
            ->assertJsonPath('error', 'agent_error');
    }

    public function test_non_admins_only_see_servers_they_have_access_to(): void
    {
        $this->actingAsMemberOf('alfa', []);
        Http::fake([self::AGENT_URL.'/servers' => Http::response(['data' => [
            $this->agentServer(),
            $this->agentServer(['id' => 'altro', 'name' => 'Altro']),
        ]])]);

        $this->getJson(route('api.v1.servers.index'))
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.id', 'alfa');
    }

    public function test_non_admins_cannot_view_servers_without_access(): void
    {
        $this->actingAsMemberOf('alfa', [ServerAbility::Power]);

        $this->getJson(route('api.v1.servers.show', 'altro'))->assertForbidden();

        Http::assertNothingSent();
    }

    public function test_power_actions_require_the_power_ability(): void
    {
        $this->actingAsMemberOf('alfa', [ServerAbility::Console]);

        $this->postJson(route('api.v1.servers.power', ['server' => 'alfa', 'action' => 'stop']))->assertForbidden();

        Http::assertNothingSent();
    }

    public function test_members_with_the_power_ability_can_control_the_server(): void
    {
        $this->actingAsMemberOf('alfa', [ServerAbility::Power]);
        Http::fake([self::AGENT_URL.'/servers/alfa/restart' => Http::response(['data' => $this->agentServer(['operation' => 'restart'])], 202)]);

        $this->postJson(route('api.v1.servers.power', ['server' => 'alfa', 'action' => 'restart']))->assertAccepted();
    }

    public function test_unapproved_users_are_rejected(): void
    {
        Sanctum::actingAs(User::factory()->admin()->pending()->create());

        $this->getJson(route('api.v1.servers.index'))
            ->assertForbidden()
            ->assertJsonPath('error', 'not_approved');

        Http::assertNothingSent();
    }

    private function actingAsUser(): void
    {
        Sanctum::actingAs(User::factory()->admin()->create());
    }

    /**
     * @param  list<ServerAbility>  $abilities
     */
    private function actingAsMemberOf(string $serverId, array $abilities): User
    {
        $user = User::factory()->create();
        ServerAccess::factory()->for($user)->abilities($abilities)->create(['server_id' => $serverId]);
        Sanctum::actingAs($user);

        return $user;
    }

    /**
     * @param  array<string, mixed>  $overrides
     * @return array<string, mixed>
     */
    private function agentServer(array $overrides = []): array
    {
        return [
            'id' => 'alfa',
            'name' => 'Alfa',
            'state' => 'running',
            'operation' => null,
            'managed' => true,
            'pid' => 97046,
            'subworlds' => 1,
            'uptimeSeconds' => 3087,
            'cpuPercent' => 30.3,
            'memoryBytes' => 3207753728,
            'players' => ['online' => 1, 'max' => 8],
            'world' => 'Alfa',
            'port' => 7777,
            'hasPassword' => false,
            'tmlVersion' => '2026.09.3.1',
            'restartRequired' => false,
            'screenSession' => 'server',
            'lastError' => null,
            ...$overrides,
        ];
    }
}
