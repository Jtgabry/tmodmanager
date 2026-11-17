<?php

namespace Tests\Feature\Api\V1;

use App\Enums\ServerAbility;
use App\Models\ServerAccess;
use App\Models\User;
use App\Models\WorkshopItem;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Http;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class ServerModTest extends TestCase
{
    use RefreshDatabase;

    private const AGENT_URL = 'http://agent.test';

    protected function setUp(): void
    {
        parent::setUp();

        config(['services.agent.url' => self::AGENT_URL, 'services.agent.token' => 'token']);
        Http::preventStrayRequests();
    }

    public function test_mods_require_the_mods_ability(): void
    {
        $this->actingAsMember([ServerAbility::Console, ServerAbility::Power]);

        $this->getJson(route('api.v1.servers.mods.index', 'alfa'))->assertForbidden();
        $this->postJson(route('api.v1.servers.mods.store', 'alfa'), ['file' => UploadedFile::fake()->create('X.tmod', 10)])->assertForbidden();
        $this->patchJson(route('api.v1.servers.mods.update', ['alfa', 'CalamityMod']), ['enabled' => false])->assertForbidden();
        $this->getJson(route('api.v1.servers.modpacks.index', 'alfa'))->assertForbidden();
        $this->get(route('api.v1.servers.modpacks.export', ['alfa', 'abcd1234']))->assertForbidden();

        Http::assertNothingSent();
    }

    public function test_lists_mods(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);
        Http::fake([self::AGENT_URL.'/servers/alfa/mods' => Http::response(['data' => ['mods' => [['name' => 'CalamityMod']], 'missingEnabled' => []]])]);

        $this->getJson(route('api.v1.servers.mods.index', 'alfa'))
            ->assertOk()
            ->assertJsonPath('data.mods.0.name', 'CalamityMod');
    }

    public function test_lists_mods_with_workshop_data_from_the_database(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);
        WorkshopItem::factory()->create(['workshop_id' => '2824688072', 'mod_name' => 'CalamityMod', 'tags' => ['Content']]);
        Http::fake([self::AGENT_URL.'/servers/alfa/mods' => Http::response(['data' => ['mods' => [
            ['name' => 'CalamityMod', 'workshopId' => '2824688072'],
            ['name' => 'Manuale', 'workshopId' => null],
        ], 'missingEnabled' => []]])]);

        $this->getJson(route('api.v1.servers.mods.index', 'alfa'))
            ->assertOk()
            ->assertJsonPath('data.mods.0.workshop.tags', ['Content'])
            ->assertJsonPath('data.mods.1.workshop', null);

        Http::assertSentCount(1);
    }

    public function test_missing_workshop_data_is_fetched_in_one_request_and_stored(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);
        WorkshopItem::factory()->create(['workshop_id' => '1']);
        Http::fake([
            self::AGENT_URL.'/servers/alfa/mods' => Http::response(['data' => ['mods' => [
                ['name' => 'A', 'workshopId' => '1'],
                ['name' => 'B', 'workshopId' => '2'],
                ['name' => 'C', 'workshopId' => '3'],
            ], 'missingEnabled' => []]]),
            self::AGENT_URL.'/workshop/details' => Http::response(['data' => [
                ['id' => '2', 'found' => true, 'title' => 'Mod B', 'modName' => 'B', 'tags' => ['Library'], 'previewUrl' => null, 'subscriptions' => 10, 'fileSize' => 5, 'timeUpdated' => '2026-10-01T00:00:00.000Z'],
                ['id' => '3', 'found' => false, 'title' => null, 'modName' => null, 'tags' => [], 'previewUrl' => null, 'subscriptions' => null, 'fileSize' => null, 'timeUpdated' => null],
            ]]),
        ]);

        $this->getJson(route('api.v1.servers.mods.index', 'alfa'))
            ->assertOk()
            ->assertJsonPath('data.mods.1.workshop.tags', ['Library'])
            ->assertJsonPath('data.mods.2.workshop', null);

        Http::assertSent(fn (Request $request): bool => $request->url() === self::AGENT_URL.'/workshop/details' && $request['ids'] === ['2', '3']);
        $this->assertDatabaseHas('workshop_items', ['workshop_id' => '2', 'title' => 'Mod B', 'found' => true]);
        $this->assertDatabaseHas('workshop_items', ['workshop_id' => '3', 'found' => false]);

        // Ora sono tutti nel database (anche quello non trovato): niente nuova richiesta
        $this->getJson(route('api.v1.servers.mods.index', 'alfa'))->assertOk();
        Http::assertSentCount(3);
    }

    public function test_mods_are_listed_even_when_the_workshop_is_unreachable(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);
        Http::fake([
            self::AGENT_URL.'/servers/alfa/mods' => Http::response(['data' => ['mods' => [['name' => 'A', 'workshopId' => '1']], 'missingEnabled' => []]]),
            self::AGENT_URL.'/workshop/details' => Http::response(['error' => 'upstream', 'message' => 'Steam non raggiungibile'], 502),
        ]);

        $this->getJson(route('api.v1.servers.mods.index', 'alfa'))
            ->assertOk()
            ->assertJsonPath('data.mods.0.workshop', null);
        $this->assertDatabaseCount('workshop_items', 0);
    }

    public function test_upload_streams_the_file_to_the_agent(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);
        Http::fake([self::AGENT_URL.'/servers/alfa/mods*' => Http::response(['data' => [
            'mod' => ['name' => 'TrashHighlight', 'version' => '1.2.3'], 'replacedVersion' => '1.2.2', 'enabled' => [], 'warning' => null,
        ]])]);

        $file = UploadedFile::fake()->createWithContent('TrashHighlight.tmod', 'TMOD-contenuto-finto');

        $this->postJson(route('api.v1.servers.mods.store', 'alfa'), ['file' => $file, 'enable' => true])
            ->assertOk()
            ->assertJsonPath('data.replacedVersion', '1.2.2');

        Http::assertSent(fn (Request $request): bool => $request->method() === 'PUT'
            && $request->url() === self::AGENT_URL.'/servers/alfa/mods?enable=1'
            && $request->hasHeader('Content-Type', 'application/octet-stream')
            && $request->body() === 'TMOD-contenuto-finto');
    }

    public function test_new_mod_upload_returns_created(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);
        Http::fake([self::AGENT_URL.'/servers/alfa/mods*' => Http::response(['data' => [
            'mod' => ['name' => 'Nuova', 'version' => '1.0'], 'replacedVersion' => null, 'enabled' => ['Nuova'], 'warning' => null,
        ]], 201)]);

        $this->postJson(route('api.v1.servers.mods.store', 'alfa'), ['file' => UploadedFile::fake()->create('Nuova.tmod', 5)])
            ->assertCreated();
    }

    public function test_upload_rejects_non_tmod_files(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);

        $this->postJson(route('api.v1.servers.mods.store', 'alfa'), ['file' => UploadedFile::fake()->create('virus.exe', 5)])
            ->assertUnprocessable()
            ->assertJsonValidationErrors('file');

        Http::assertNothingSent();
    }

    public function test_disabling_a_mod_with_dependents_returns_the_dependents(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);
        Http::fake([self::AGENT_URL.'/servers/alfa/mods/CalamityMod' => Http::response([
            'error' => 'conflict', 'message' => 'Altre mod abilitate dipendono da questa: InfernumMode', 'details' => ['dependents' => ['InfernumMode']],
        ], 409)]);

        $this->patchJson(route('api.v1.servers.mods.update', ['alfa', 'CalamityMod']), ['enabled' => false])
            ->assertConflict()
            ->assertJsonPath('details.dependents', ['InfernumMode']);

        Http::assertSent(fn (Request $request): bool => $request['enabled'] === false && $request['cascade'] === false);
    }

    public function test_invalid_mod_names_are_not_routed(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);

        $this->patchJson('/api/v1/servers/alfa/mods/..%2F..%2Fx', ['enabled' => true])->assertNotFound();
        $this->deleteJson('/api/v1/servers/alfa/mods/Bad-Name')->assertNotFound();

        Http::assertNothingSent();
    }

    public function test_delete_passes_cascade(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);
        Http::fake([self::AGENT_URL.'/servers/alfa/mods/MagicStorage*' => Http::response(['data' => ['disabled' => ['MagicStorage', 'MSStarterBag']]])]);

        $this->deleteJson(route('api.v1.servers.mods.destroy', ['alfa', 'MagicStorage', 'cascade' => 1]))
            ->assertOk()
            ->assertJsonPath('data.disabled', ['MagicStorage', 'MSStarterBag']);

        Http::assertSent(fn (Request $request): bool => $request->method() === 'DELETE' && str_contains($request->url(), 'cascade=1'));
    }

    public function test_icon_is_served_as_a_cacheable_png(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);
        Http::fake([
            self::AGENT_URL.'/servers/alfa/mods/CalamityMod/icon' => Http::response("\x89PNG-icona", 200, ['Content-Type' => 'image/png']),
            self::AGENT_URL.'/servers/alfa/mods/NoIcon/icon' => Http::response(['error' => 'not_found', 'message' => "La mod non ha un'icona"], 404),
        ]);

        $response = $this->get(route('api.v1.servers.mods.icon', ['alfa', 'CalamityMod']));
        $response->assertOk()
            ->assertHeader('Content-Type', 'image/png')
            ->assertHeader('X-Content-Type-Options', 'nosniff');
        $this->assertStringContainsString('max-age=31536000', (string) $response->headers->get('Cache-Control'));
        $this->assertSame("\x89PNG-icona", $response->getContent());

        $this->getJson(route('api.v1.servers.mods.icon', ['alfa', 'NoIcon']))->assertNotFound();
    }

    public function test_icon_requires_the_mods_ability(): void
    {
        $this->actingAsMember([ServerAbility::Console]);

        $this->get(route('api.v1.servers.mods.icon', ['alfa', 'CalamityMod']))->assertForbidden();
        Http::assertNothingSent();
    }

    public function test_download_streams_the_mod(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);
        Http::fake([self::AGENT_URL.'/servers/alfa/mods/FourLeafClover/download' => Http::response('BYTES-DELLA-MOD', 200, ['Content-Type' => 'application/octet-stream'])]);

        $response = $this->get(route('api.v1.servers.mods.download', ['alfa', 'FourLeafClover']));

        $response->assertOk()->assertHeader('Content-Disposition', 'attachment; filename=FourLeafClover.tmod');
        $this->assertSame('BYTES-DELLA-MOD', $response->streamedContent());
    }

    public function test_modpack_export_streams_the_zip_with_the_agent_filename(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);
        Http::fake([self::AGENT_URL.'/servers/alfa/modpacks/abcd1234/export' => Http::response('PK-ZIP', 200, [
            'Content-Type' => 'application/zip',
            'Content-Disposition' => 'attachment; filename="Boss.zip"',
        ])]);

        $response = $this->get(route('api.v1.servers.modpacks.export', ['alfa', 'abcd1234']));

        $response->assertOk()->assertHeader('Content-Disposition', 'attachment; filename="Boss.zip"');
        $this->assertSame('PK-ZIP', $response->streamedContent());
    }

    public function test_modpack_crud_and_activation(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);
        Http::fake([
            self::AGENT_URL.'/servers/alfa/modpacks' => Http::response(['data' => ['id' => 'abcd1234', 'name' => 'Boss']], 201),
            self::AGENT_URL.'/servers/alfa/modpacks/abcd1234/enable' => Http::response(['data' => ['enabled' => ['InfernumMode']]]),
            self::AGENT_URL.'/servers/alfa/modpacks/abcd1234/disable' => Http::response(['data' => ['disabled' => ['InfernumMode'], 'kept' => []]]),
            self::AGENT_URL.'/servers/alfa/modpacks/abcd1234' => Http::response(null, 204),
        ]);

        $this->postJson(route('api.v1.servers.modpacks.store', 'alfa'), ['name' => ' Boss ', 'mods' => ['InfernumMode']])
            ->assertCreated()
            ->assertJsonPath('data.id', 'abcd1234');
        Http::assertSent(fn (Request $request): bool => $request->method() === 'POST' && $request['name'] === 'Boss' && $request['mods'] === ['InfernumMode']);

        $this->postJson(route('api.v1.servers.modpacks.activate', ['alfa', 'abcd1234']))->assertOk()->assertJsonPath('data.enabled', ['InfernumMode']);
        $this->deleteJson(route('api.v1.servers.modpacks.deactivate', ['alfa', 'abcd1234']))->assertOk()->assertJsonPath('data.disabled', ['InfernumMode']);
        $this->deleteJson(route('api.v1.servers.modpacks.destroy', ['alfa', 'abcd1234']))->assertNoContent();
    }

    public function test_exclusive_modpack_activation(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);
        Http::fake([self::AGENT_URL.'/servers/alfa/modpacks/abcd1234/enable' => Http::response(['data' => ['enabled' => [], 'disabled' => ['Fargo'], 'deactivated' => ['Altro']]])]);

        $this->postJson(route('api.v1.servers.modpacks.activate', ['alfa', 'abcd1234']), ['exclusive' => true])
            ->assertOk()
            ->assertJsonPath('data.disabled', ['Fargo']);
        $this->postJson(route('api.v1.servers.modpacks.activate', ['alfa', 'abcd1234']), ['exclusive' => 'forse'])->assertUnprocessable();

        Http::assertSentCount(1);
        Http::assertSent(fn (Request $request): bool => $request['exclusive'] === true);
    }

    public function test_modpack_validation(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);

        $this->postJson(route('api.v1.servers.modpacks.store', 'alfa'), ['name' => '', 'mods' => ['ok', 'non valido!']])
            ->assertUnprocessable()
            ->assertJsonValidationErrors(['name', 'mods.1']);

        Http::assertNothingSent();
    }

    public function test_modpack_versions_are_forwarded_as_an_object(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);
        Http::fake([self::AGENT_URL.'/servers/alfa/modpacks*' => Http::response(['data' => ['id' => 'abcd1234']], 201)]);

        $this->postJson(route('api.v1.servers.modpacks.store', 'alfa'), ['name' => 'Boss', 'mods' => ['CalamityMod'], 'versions' => ['CalamityMod' => '2.0.3']])->assertCreated();
        $this->putJson(route('api.v1.servers.modpacks.update', ['alfa', 'abcd1234']), ['name' => 'Boss', 'mods' => []])->assertOk();

        $bodies = Http::recorded()->map(fn (array $pair): string => $pair[0]->body())->all();
        $this->assertStringContainsString('"versions":{"CalamityMod":"2.0.3"}', $bodies[0]);
        $this->assertStringContainsString('"versions":{}', $bodies[1]);

        $this->postJson(route('api.v1.servers.modpacks.store', 'alfa'), ['name' => 'X', 'mods' => [], 'versions' => ['CalamityMod' => 'ultima']])
            ->assertUnprocessable()->assertJsonValidationErrors(['versions.CalamityMod']);
        $this->postJson(route('api.v1.servers.modpacks.store', 'alfa'), ['name' => 'X', 'mods' => [], 'versions' => ['non valido!' => '1.0']])
            ->assertUnprocessable()->assertJsonValidationErrors(['versions']);
    }

    public function test_version_archive(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);
        Http::fake([
            self::AGENT_URL.'/servers/alfa/archive/CalamityMod/2.0.3/use' => Http::response(['data' => ['replacedVersion' => '2.0.4']]),
            self::AGENT_URL.'/servers/alfa/archive/CalamityMod/2.0.3' => Http::response(null, 204),
            self::AGENT_URL.'/servers/alfa/archive' => Http::sequence()
                ->push(['data' => [['name' => 'CalamityMod', 'versions' => [['version' => '2.0.3']]]]])
                ->push(['data' => ['name' => 'CalamityMod', 'version' => '2.0.1']], 201),
        ]);

        $this->getJson(route('api.v1.servers.archive.index', 'alfa'))->assertOk()->assertJsonPath('data.0.versions.0.version', '2.0.3');
        $this->postJson(route('api.v1.servers.archive.store', 'alfa'), ['file' => UploadedFile::fake()->createWithContent('Calamity.tmod', 'TMOD-finto')])
            ->assertCreated()->assertJsonPath('data.version', '2.0.1');
        $this->postJson(route('api.v1.servers.archive.use', ['alfa', 'CalamityMod', '2.0.3']))->assertOk()->assertJsonPath('data.replacedVersion', '2.0.4');
        $this->deleteJson(route('api.v1.servers.archive.destroy', ['alfa', 'CalamityMod', '2.0.3']))->assertNoContent();

        Http::assertSent(fn (Request $request): bool => $request->method() === 'PUT' && $request->url() === self::AGENT_URL.'/servers/alfa/archive');
        $this->deleteJson('/api/v1/servers/alfa/archive/CalamityMod/latest')->assertNotFound();
    }

    public function test_version_archive_requires_the_mods_ability(): void
    {
        $this->actingAsMember([ServerAbility::Files]);

        $this->getJson(route('api.v1.servers.archive.index', 'alfa'))->assertForbidden();
        $this->postJson(route('api.v1.servers.archive.store', 'alfa'), ['file' => UploadedFile::fake()->create('X.tmod', 1)])->assertForbidden();
        $this->deleteJson(route('api.v1.servers.archive.destroy', ['alfa', 'CalamityMod', '1.0']))->assertForbidden();
        $this->postJson(route('api.v1.servers.archive.use', ['alfa', 'CalamityMod', '1.0']))->assertForbidden();

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
