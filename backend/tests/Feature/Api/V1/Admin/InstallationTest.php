<?php

namespace Tests\Feature\Api\V1\Admin;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class InstallationTest extends TestCase
{
    use RefreshDatabase;

    private const AGENT_URL = 'http://agent.test';

    protected function setUp(): void
    {
        parent::setUp();

        config(['services.agent.url' => self::AGENT_URL, 'services.agent.token' => 'token']);
        Http::preventStrayRequests();
    }

    public function test_only_admins_can_update_tmodloader(): void
    {
        Sanctum::actingAs(User::factory()->create());

        $this->getJson(route('api.v1.admin.installations.index'))->assertForbidden();
        $this->postJson(route('api.v1.admin.installations.update', 'abcdef12'), ['version' => '2026.10.2.3'])->assertForbidden();

        Http::assertNothingSent();
    }

    public function test_lists_installations_and_releases(): void
    {
        Sanctum::actingAs(User::factory()->admin()->create());
        Http::fake([
            self::AGENT_URL.'/admin/installations' => Http::response(['data' => [['id' => 'abcdef12', 'version' => '2026.09.3.1']]]),
            self::AGENT_URL.'/admin/tml/releases*' => Http::response(['data' => [['version' => '2026.10.2.3', 'prerelease' => true]]]),
        ]);

        $this->getJson(route('api.v1.admin.installations.index'))->assertOk()->assertJsonPath('data.0.version', '2026.09.3.1');
        $this->getJson(route('api.v1.admin.tmodloader.releases', ['refresh' => 1]))->assertOk()->assertJsonPath('data.0.prerelease', true);

        Http::assertSent(fn (Request $request): bool => $request->url() === self::AGENT_URL.'/admin/tml/releases?refresh=1');
    }

    public function test_starts_an_update(): void
    {
        Sanctum::actingAs(User::factory()->admin()->create());
        Http::fake([self::AGENT_URL.'/admin/installations/abcdef12/update' => Http::response(['data' => ['phase' => 'download']], 202)]);

        $this->postJson(route('api.v1.admin.installations.update', 'abcdef12'), ['version' => '2026.10.2.3', 'restartServers' => false])
            ->assertAccepted()
            ->assertJsonPath('data.phase', 'download');

        Http::assertSent(fn (Request $request): bool => $request->data() === ['version' => '2026.10.2.3', 'restartServers' => false]);
    }

    public function test_rollback_to_a_backup_restarts_servers_by_default(): void
    {
        Sanctum::actingAs(User::factory()->admin()->create());
        Http::fake([self::AGENT_URL.'/admin/installations/abcdef12/update' => Http::response(['data' => ['phase' => 'prepare']], 202)]);

        $this->postJson(route('api.v1.admin.installations.update', 'abcdef12'), ['backup' => '/home/utente/tModLoader-v2026.8.3.0'])
            ->assertAccepted();

        Http::assertSent(fn (Request $request): bool => $request->data() === ['backup' => '/home/utente/tModLoader-v2026.8.3.0', 'restartServers' => true]);
    }

    public function test_requires_a_version_or_a_backup(): void
    {
        Sanctum::actingAs(User::factory()->admin()->create());

        $this->postJson(route('api.v1.admin.installations.update', 'abcdef12'), ['version' => '../../x'])
            ->assertUnprocessable()
            ->assertJsonValidationErrors('version');
        $this->postJson(route('api.v1.admin.installations.update', 'abcdef12'), [])
            ->assertUnprocessable()
            ->assertJsonValidationErrors(['version', 'backup']);

        Http::assertNothingSent();
    }
}
