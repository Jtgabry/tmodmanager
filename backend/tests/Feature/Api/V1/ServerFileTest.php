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

class ServerFileTest extends TestCase
{
    use RefreshDatabase;

    private const AGENT_URL = 'http://agent.test';

    protected function setUp(): void
    {
        parent::setUp();

        config(['services.agent.url' => self::AGENT_URL, 'services.agent.token' => 'token']);
        Http::preventStrayRequests();
    }

    public function test_files_require_the_files_ability(): void
    {
        $this->actingAsMember([ServerAbility::Mods, ServerAbility::Console]);

        $this->getJson(route('api.v1.servers.files.index', ['alfa', 'root' => 'save']))->assertForbidden();
        $this->getJson(route('api.v1.servers.files.content.show', ['alfa', 'root' => 'tml', 'path' => 'serverconfig.txt']))->assertForbidden();
        $this->deleteJson(route('api.v1.servers.files.destroy', ['alfa', 'root' => 'save', 'path' => 'Mods']))->assertForbidden();

        Http::assertNothingSent();
    }

    public function test_lists_a_directory(): void
    {
        $this->actingAsMember([ServerAbility::Files]);
        Http::fake([self::AGENT_URL.'/servers/alfa/files*' => Http::response(['data' => ['root' => 'save', 'path' => 'Mods', 'entries' => []]])]);

        $this->getJson(route('api.v1.servers.files.index', ['alfa', 'root' => 'save', 'path' => 'Mods']))
            ->assertOk()
            ->assertJsonPath('data.path', 'Mods');

        Http::assertSent(fn (Request $request): bool => $request->url() === self::AGENT_URL.'/servers/alfa/files?root=save&path=Mods');
    }

    public function test_root_must_be_a_simple_identifier(): void
    {
        $this->actingAsMember([ServerAbility::Files]);

        $this->getJson(route('api.v1.servers.files.index', ['alfa', 'root' => '../etc']))
            ->assertUnprocessable()
            ->assertJsonValidationErrors('root');

        Http::assertNothingSent();
    }

    public function test_agent_path_errors_are_returned(): void
    {
        $this->actingAsMember([ServerAbility::Files]);
        Http::fake([self::AGENT_URL.'/*' => Http::response(['error' => 'invalid', 'message' => 'Percorso fuori dalla cartella consentita'], 422)]);

        $this->getJson(route('api.v1.servers.files.index', ['alfa', 'root' => 'save', 'path' => '../../etc']))
            ->assertUnprocessable()
            ->assertJsonPath('message', 'Percorso fuori dalla cartella consentita');
    }

    public function test_upload_streams_with_original_name(): void
    {
        $this->actingAsMember([ServerAbility::Files]);
        Http::fake([self::AGENT_URL.'/servers/alfa/files/upload*' => Http::response(['data' => ['name' => 'mondo.wld', 'size' => 5, 'replaced' => false]], 201)]);

        $this->postJson(route('api.v1.servers.files.upload', 'alfa'), [
            'file' => UploadedFile::fake()->createWithContent('mondo.wld', 'dati!'),
            'root' => 'worlds',
            'path' => '',
        ])->assertCreated();

        Http::assertSent(fn (Request $request): bool => $request->method() === 'PUT'
            && str_contains($request->url(), 'root=worlds')
            && str_contains($request->url(), 'name=mondo.wld')
            && str_contains($request->url(), 'overwrite=0')
            && $request->body() === 'dati!');
    }

    public function test_upload_conflict_is_returned(): void
    {
        $this->actingAsMember([ServerAbility::Files]);
        Http::fake([self::AGENT_URL.'/*' => Http::response(['error' => 'conflict', 'message' => 'Il file "a.txt" esiste già'], 409)]);

        $this->postJson(route('api.v1.servers.files.upload', 'alfa'), [
            'file' => UploadedFile::fake()->createWithContent('a.txt', 'x'),
            'root' => 'save',
        ])->assertConflict();
    }

    public function test_download_passes_through_the_agent_filename(): void
    {
        $this->actingAsMember([ServerAbility::Files]);
        Http::fake([self::AGENT_URL.'/servers/alfa/files/download*' => Http::response('TARGZ', 200, [
            'Content-Disposition' => 'attachment; filename="Worlds.tar.gz"',
        ])]);

        $response = $this->get(route('api.v1.servers.files.download', ['alfa', 'root' => 'save', 'path' => 'Worlds']));

        $response->assertOk()->assertHeader('Content-Disposition', 'attachment; filename="Worlds.tar.gz"');
        $this->assertSame('TARGZ', $response->streamedContent());
    }

    public function test_mkdir_rename_and_delete_are_forwarded(): void
    {
        $this->actingAsMember([ServerAbility::Files]);
        Http::fake([
            self::AGENT_URL.'/servers/alfa/files/mkdir' => Http::response(['data' => ['name' => 'Nuova']], 201),
            self::AGENT_URL.'/servers/alfa/files/rename' => Http::response(['data' => ['name' => 'Rinominata']]),
            self::AGENT_URL.'/servers/alfa/files?*' => Http::response(null, 204),
        ]);

        $this->postJson(route('api.v1.servers.files.directories.store', 'alfa'), ['root' => 'save', 'name' => 'Nuova'])->assertCreated();
        $this->postJson(route('api.v1.servers.files.rename', 'alfa'), ['root' => 'save', 'path' => 'Nuova', 'name' => 'Rinominata'])->assertOk();
        $this->deleteJson(route('api.v1.servers.files.destroy', ['alfa', 'root' => 'save', 'path' => 'Rinominata']))->assertNoContent();

        Http::assertSent(fn (Request $request): bool => $request->method() === 'DELETE'
            && $request->url() === self::AGENT_URL.'/servers/alfa/files?root=save&path=Rinominata');
    }

    public function test_text_files_can_be_read_and_saved(): void
    {
        $this->actingAsMember([ServerAbility::Files]);
        Http::fake([self::AGENT_URL.'/servers/alfa/files/content*' => Http::sequence()
            ->push(['data' => ['content' => "port=7777\n", 'modifiedAt' => '2026-11-03T10:00:00.000Z']])
            ->push(['data' => ['modifiedAt' => '2026-11-03T10:05:00.000Z']]),
        ]);

        $this->getJson(route('api.v1.servers.files.content.show', ['alfa', 'root' => 'tml', 'path' => 'serverconfig.txt']))
            ->assertOk()
            ->assertJsonPath('data.content', "port=7777\n");

        $this->putJson(route('api.v1.servers.files.content.update', 'alfa'), [
            'root' => 'tml', 'path' => 'serverconfig.txt', 'content' => "  # indentato\nport=8888\n\n", 'expectedModifiedAt' => '2026-11-03T10:00:00.000Z',
        ])->assertOk()->assertJsonPath('data.modifiedAt', '2026-11-03T10:05:00.000Z');

        Http::assertSent(fn (Request $request): bool => $request->method() === 'PUT' && $request['content'] === "  # indentato\nport=8888\n\n");
    }

    public function test_saving_an_empty_file_is_allowed(): void
    {
        $this->actingAsMember([ServerAbility::Files]);
        Http::fake([self::AGENT_URL.'/*' => Http::response(['data' => ['modifiedAt' => 'x']])]);

        $this->putJson(route('api.v1.servers.files.content.update', 'alfa'), ['root' => 'save', 'path' => 'vuoto.txt', 'content' => ''])
            ->assertOk();

        Http::assertSent(fn (Request $request): bool => $request['content'] === '');
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
