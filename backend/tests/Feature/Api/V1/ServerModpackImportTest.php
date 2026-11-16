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

class ServerModpackImportTest extends TestCase
{
    use RefreshDatabase;

    private const AGENT_URL = 'http://agent.test';

    protected function setUp(): void
    {
        parent::setUp();

        config(['services.agent.url' => self::AGENT_URL, 'services.agent.token' => 'token']);
        Http::preventStrayRequests();
    }

    public function test_import_requires_the_mods_ability(): void
    {
        $this->actingAsMember([ServerAbility::Files]);

        $this->getJson(route('api.v1.servers.modpacks.importable', 'alfa'))->assertForbidden();
        $this->postJson(route('api.v1.servers.modpacks.import', 'alfa'), ['name' => 'Pack'])->assertForbidden();

        Http::assertNothingSent();
    }

    public function test_imports_a_pack_from_the_server_folder(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);
        Http::fake([self::AGENT_URL.'/servers/alfa/modpacks/import' => Http::response(['data' => [
            'pack' => ['id' => 'abcd1234', 'name' => 'Calamity'], 'installed' => ['CalamityMod'], 'updated' => [], 'skipped' => [], 'missing' => [],
        ]], 201)]);

        $this->postJson(route('api.v1.servers.modpacks.import', 'alfa'), ['name' => 'Calamity', 'replaceExisting' => true])
            ->assertCreated()
            ->assertJsonPath('data.pack.name', 'Calamity');

        Http::assertSent(fn (Request $request): bool => $request->method() === 'POST'
            && $request['name'] === 'Calamity'
            && $request['replaceExisting'] === true);
    }

    public function test_uploads_a_zip_in_streaming(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);
        Http::fake([self::AGENT_URL.'/servers/alfa/modpacks/import*' => Http::response(['data' => ['pack' => ['name' => 'Mio Pack']]], 201)]);

        $file = UploadedFile::fake()->createWithContent('Mio Pack.zip', 'PK-finto');

        $this->postJson(route('api.v1.servers.modpacks.import', 'alfa'), ['file' => $file])->assertCreated();

        Http::assertSent(fn (Request $request): bool => $request->method() === 'PUT'
            && $request->url() === self::AGENT_URL.'/servers/alfa/modpacks/import?filename=Mio+Pack.zip&replaceExisting=0'
            && $request->body() === 'PK-finto');
    }

    public function test_rejects_other_file_types_and_missing_input(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);

        $this->postJson(route('api.v1.servers.modpacks.import', 'alfa'), ['file' => UploadedFile::fake()->create('pack.rar', 5)])
            ->assertUnprocessable()
            ->assertJsonValidationErrors('file');
        $this->postJson(route('api.v1.servers.modpacks.import', 'alfa'), [])
            ->assertUnprocessable()
            ->assertJsonValidationErrors(['name', 'file']);

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
