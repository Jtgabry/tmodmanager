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

class ServerBackupTest extends TestCase
{
    use RefreshDatabase;

    private const AGENT_URL = 'http://agent.test';

    private const BACKUP = 'Il_mio_Mondo_backup_20261117040000.zip';

    protected function setUp(): void
    {
        parent::setUp();

        config(['services.agent.url' => self::AGENT_URL, 'services.agent.token' => 'token']);
        Http::preventStrayRequests();
    }

    public function test_backups_require_the_backups_ability(): void
    {
        $this->actingAsMember([ServerAbility::Files, ServerAbility::Console]);

        $this->getJson(route('api.v1.servers.backups.index', 'alfa'))->assertForbidden();
        $this->postJson(route('api.v1.servers.backups.store', 'alfa'))->assertForbidden();
        $this->get(route('api.v1.servers.backups.download', ['alfa', self::BACKUP]))->assertForbidden();
        $this->deleteJson(route('api.v1.servers.backups.destroy', ['alfa', self::BACKUP]))->assertForbidden();

        Http::assertNothingSent();
    }

    public function test_lists_and_creates_backups(): void
    {
        $this->actingAsMember([ServerAbility::Backups]);
        Http::fake([self::AGENT_URL.'/servers/alfa/backups' => Http::sequence()
            ->push(['data' => ['backups' => [['name' => self::BACKUP]], 'schedule' => ['time' => '04:00']]])
            ->push(['data' => ['backup' => ['name' => self::BACKUP], 'saved' => true, 'running' => true]], 201),
        ]);

        $this->getJson(route('api.v1.servers.backups.index', 'alfa'))
            ->assertOk()
            ->assertJsonPath('data.backups.0.name', self::BACKUP)
            ->assertJsonPath('data.schedule.time', '04:00');
        $this->postJson(route('api.v1.servers.backups.store', 'alfa'))
            ->assertCreated()
            ->assertJsonPath('data.backup.name', self::BACKUP);

        Http::assertSent(fn (Request $request): bool => $request->method() === 'POST' && $request->url() === self::AGENT_URL.'/servers/alfa/backups');
    }

    public function test_downloads_and_deletes_a_backup(): void
    {
        $this->actingAsMember([ServerAbility::Backups]);
        Http::fake([
            self::AGENT_URL.'/servers/alfa/backups/'.self::BACKUP.'/download' => Http::response('PK-ZIP', 200, ['Content-Type' => 'application/zip']),
            self::AGENT_URL.'/servers/alfa/backups/'.self::BACKUP => Http::response(null, 204),
        ]);

        $response = $this->get(route('api.v1.servers.backups.download', ['alfa', self::BACKUP]));
        $response->assertOk()->assertHeader('Content-Disposition', 'attachment; filename='.self::BACKUP);
        $this->assertSame('PK-ZIP', $response->streamedContent());

        $this->deleteJson(route('api.v1.servers.backups.destroy', ['alfa', self::BACKUP]))->assertNoContent();
        Http::assertSent(fn (Request $request): bool => $request->method() === 'DELETE');
    }

    public function test_invalid_backup_names_never_reach_the_agent(): void
    {
        $this->actingAsMember([ServerAbility::Backups]);

        $this->get('/api/v1/servers/alfa/backups/..%2Fservers.json/download')->assertNotFound();
        $this->deleteJson('/api/v1/servers/alfa/backups/mondo.zip')->assertNotFound();

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
