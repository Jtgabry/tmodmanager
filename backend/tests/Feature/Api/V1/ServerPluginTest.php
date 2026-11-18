<?php

namespace Tests\Feature\Api\V1;

use App\Enums\ServerAbility;
use App\Models\ServerAccess;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Http;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class ServerPluginTest extends TestCase
{
    use RefreshDatabase;

    private const AGENT_URL = 'http://agent.test';

    private const VERSION = '0123456789abcdef';

    protected function setUp(): void
    {
        parent::setUp();

        config(['services.agent.url' => self::AGENT_URL, 'services.agent.token' => 'token']);
        Http::preventStrayRequests();
    }

    public function test_plugins_require_the_mods_ability(): void
    {
        $this->actingAsMember([ServerAbility::Console, ServerAbility::Files]);

        $this->getJson(route('api.v1.servers.plugins.index', 'alfa'))->assertForbidden();
        $this->postJson(route('api.v1.servers.plugins.store', 'alfa'), ['file' => UploadedFile::fake()->create('X.dll', 10)])->assertForbidden();
        $this->patchJson(route('api.v1.servers.plugins.update', ['alfa', 'Mappa']), ['enabled' => true])->assertForbidden();
        $this->postJson(route('api.v1.servers.plugins.versions.use', ['alfa', 'Mappa', self::VERSION]))->assertForbidden();
        $this->deleteJson(route('api.v1.servers.plugins.versions.prune', ['alfa', 'Mappa']))->assertForbidden();
        $this->get(route('api.v1.servers.plugins.versions.download', ['alfa', 'Mappa', self::VERSION]))->assertForbidden();

        Http::assertNothingSent();
    }

    public function test_lists_plugins(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);
        Http::fake([self::AGENT_URL.'/servers/alfa/plugins' => Http::response(['data' => [
            'plugins' => [['name' => 'Mappa', 'enabled' => true, 'versions' => [['id' => self::VERSION]]]],
            'bundled' => [['file' => 'TShockAPI.dll']],
        ]])]);

        $this->getJson(route('api.v1.servers.plugins.index', 'alfa'))
            ->assertOk()
            ->assertJsonPath('data.plugins.0.name', 'Mappa')
            ->assertJsonPath('data.bundled.0.file', 'TShockAPI.dll');
    }

    public function test_upload_streams_the_dll_with_its_name(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);
        Http::fake([self::AGENT_URL.'/servers/alfa/plugins*' => Http::response(['data' => [
            'plugin' => ['name' => 'Mappa'], 'versionId' => self::VERSION, 'duplicate' => false, 'previousVersion' => null,
        ]], 201)]);

        $file = UploadedFile::fake()->createWithContent('Mappa.dll', 'MZ-contenuto-finto');

        $this->postJson(route('api.v1.servers.plugins.store', 'alfa'), ['file' => $file, 'enable' => true])
            ->assertCreated()
            ->assertJsonPath('data.versionId', self::VERSION);

        Http::assertSent(fn (Request $request): bool => $request->method() === 'PUT'
            && $request->url() === self::AGENT_URL.'/servers/alfa/plugins?filename=Mappa.dll&enable=1'
            && $request->hasHeader('Content-Type', 'application/octet-stream')
            && $request->body() === 'MZ-contenuto-finto');
    }

    public function test_upload_rejects_non_dll_files(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);

        $this->postJson(route('api.v1.servers.plugins.store', 'alfa'), ['file' => UploadedFile::fake()->create('plugin.zip', 5)])
            ->assertUnprocessable()
            ->assertJsonValidationErrors('file');

        Http::assertNothingSent();
    }

    public function test_versions_are_used_and_deleted_through_the_agent(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);
        Http::fake([
            self::AGENT_URL.'/servers/alfa/plugins/Mappa/versions/'.self::VERSION.'/use' => Http::response(['data' => ['name' => 'Mappa', 'selected' => self::VERSION]]),
            self::AGENT_URL.'/servers/alfa/plugins/Mappa/versions/'.self::VERSION => Http::response(['data' => ['name' => 'Mappa']]),
            self::AGENT_URL.'/servers/alfa/plugins/Mappa/versions' => Http::response(['data' => ['removed' => 2]]),
            self::AGENT_URL.'/servers/alfa/plugins/Mappa' => Http::response(null, 204),
        ]);

        $this->postJson(route('api.v1.servers.plugins.versions.use', ['alfa', 'Mappa', self::VERSION]))
            ->assertOk()
            ->assertJsonPath('data.selected', self::VERSION);
        $this->deleteJson(route('api.v1.servers.plugins.versions.destroy', ['alfa', 'Mappa', self::VERSION]))->assertOk();
        $this->deleteJson(route('api.v1.servers.plugins.versions.prune', ['alfa', 'Mappa']))
            ->assertOk()
            ->assertJsonPath('data.removed', 2);
        $this->deleteJson(route('api.v1.servers.plugins.destroy', ['alfa', 'Mappa']))->assertNoContent();

        Http::assertSent(fn (Request $request): bool => $request->method() === 'DELETE'
            && $request->url() === self::AGENT_URL.'/servers/alfa/plugins/Mappa/versions');
    }

    public function test_invalid_version_ids_do_not_reach_the_agent(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);

        $this->postJson('/api/v1/servers/alfa/plugins/Mappa/versions/../use')->assertNotFound();
        $this->postJson('/api/v1/servers/alfa/plugins/Mappa/versions/XYZ/use')->assertNotFound();

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
