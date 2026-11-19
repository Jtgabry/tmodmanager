<?php

namespace Tests\Feature\Api\V1;

use App\Enums\ServerAbility;
use App\Models\ServerAccess;
use App\Models\User;
use App\Models\WorkshopItem;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class ServerModWorkshopTest extends TestCase
{
    use RefreshDatabase;

    private const AGENT_URL = 'http://agent.test';

    protected function setUp(): void
    {
        parent::setUp();

        config(['services.agent.url' => self::AGENT_URL, 'services.agent.token' => 'token']);
        Http::preventStrayRequests();
    }

    public function test_workshop_endpoints_require_the_mods_ability(): void
    {
        $this->actingAsMember([ServerAbility::Files]);

        $this->getJson(route('api.v1.servers.mods.workshop.index', 'alfa'))->assertForbidden();
        $this->postJson(route('api.v1.servers.mods.workshop.store', 'alfa'), ['mods' => ['CalamityMod']])->assertForbidden();
        $this->getJson(route('api.v1.servers.mods.workshop.job', 'alfa'))->assertForbidden();
        $this->deleteJson(route('api.v1.servers.mods.workshop.cancel', ['alfa', 'CalamityMod']))->assertForbidden();
        $this->putJson(route('api.v1.servers.mods.workshop.link', ['alfa', 'CalamityMod']), ['workshop' => '1'])->assertForbidden();
        $this->deleteJson(route('api.v1.servers.mods.workshop.unlink', ['alfa', 'CalamityMod']))->assertForbidden();
        $this->getJson(route('api.v1.servers.mods.workshop.search', ['alfa', 'q' => 'calamity']))->assertForbidden();

        Http::assertNothingSent();
    }

    public function test_lists_updates_and_forwards_refresh(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);
        Http::fake([self::AGENT_URL.'/servers/alfa/mods/updates*' => Http::response(['data' => [
            'apiKey' => true, 'steamcmd' => true, 'tmlVersion' => '2026.9.3.1', 'checkedAt' => now()->toIso8601String(),
            'mods' => [['name' => 'Wikithis', 'status' => 'update', 'installedVersion' => '2.5.1.4', 'latestVersion' => '2.5.1.5']],
            'items' => [['id' => '2563309347', 'found' => true, 'title' => 'Wikithis', 'modName' => 'Wikithis', 'tags' => ['Quality of Life', 'Utilities'], 'previewUrl' => 'https://images.example/1.png', 'subscriptions' => 1000, 'fileSize' => 10, 'timeUpdated' => '2026-10-01T00:00:00.000Z']],
        ]])]);

        $this->getJson(route('api.v1.servers.mods.workshop.index', ['alfa', 'refresh' => 1]))
            ->assertOk()
            ->assertJsonPath('data.mods.0.status', 'update')
            ->assertJsonMissingPath('data.items')
            ->assertJsonMissingPath('data.apiKeyValue');

        $item = WorkshopItem::firstWhere('workshop_id', '2563309347');
        $this->assertSame(['Quality of Life', 'Utilities'], $item->tags);
        $this->assertSame('Wikithis', $item->mod_name);

        Http::assertSent(fn (Request $request): bool => $request->url() === self::AGENT_URL.'/servers/alfa/mods/updates?refresh=1');
    }

    public function test_starts_an_update_job(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);
        Http::fake([self::AGENT_URL.'/servers/alfa/mods/updates' => Http::response(['data' => ['state' => 'running', 'items' => []]], 202)]);

        $this->postJson(route('api.v1.servers.mods.workshop.store', 'alfa'), ['mods' => ['Wikithis', 'CalamityMod']])
            ->assertAccepted()
            ->assertJsonPath('data.state', 'running');

        Http::assertSent(fn (Request $request): bool => $request->method() === 'POST' && $request['mods'] === ['Wikithis', 'CalamityMod']);
    }

    public function test_cancels_a_download(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);
        Http::fake([self::AGENT_URL.'/servers/alfa/mods/updates/job/CalamityMod' => Http::response(['data' => ['state' => 'running', 'items' => [['name' => 'CalamityMod', 'state' => 'cancelled']]]])]);

        $this->deleteJson(route('api.v1.servers.mods.workshop.cancel', ['alfa', 'CalamityMod']))
            ->assertOk()
            ->assertJsonPath('data.items.0.state', 'cancelled');

        Http::assertSent(fn (Request $request): bool => $request->method() === 'DELETE');
    }

    public function test_rejects_invalid_mod_names(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);

        $this->postJson(route('api.v1.servers.mods.workshop.store', 'alfa'), ['mods' => ['../etc']])
            ->assertUnprocessable()
            ->assertJsonValidationErrors('mods.0');
        $this->postJson(route('api.v1.servers.mods.workshop.store', 'alfa'), ['mods' => []])
            ->assertUnprocessable();

        Http::assertNothingSent();
    }

    public function test_links_and_unlinks_a_mod(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);
        Http::fake([self::AGENT_URL.'/servers/alfa/mods/CalamityMod/workshop' => Http::response(null, 204)]);

        $this->putJson(route('api.v1.servers.mods.workshop.link', ['alfa', 'CalamityMod']), ['workshop' => 'https://steamcommunity.com/sharedfiles/filedetails/?id=2824688072'])
            ->assertNoContent();
        $this->putJson(route('api.v1.servers.mods.workshop.link', ['alfa', 'CalamityMod']), ['workshop' => null])
            ->assertNoContent();
        $this->deleteJson(route('api.v1.servers.mods.workshop.unlink', ['alfa', 'CalamityMod']))->assertNoContent();

        Http::assertSent(fn (Request $request): bool => $request->method() === 'PUT' && $request['workshop'] === null);
        Http::assertSentCount(3);
    }

    public function test_search_results_are_stored(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);
        Http::fake([self::AGENT_URL.'/workshop/search*' => Http::response(['data' => [
            ['id' => '2824688072', 'found' => true, 'title' => 'Calamity Mod', 'modName' => 'CalamityMod', 'tags' => ['Content'], 'previewUrl' => null, 'subscriptions' => 900000, 'fileSize' => 1, 'timeUpdated' => null, 'url' => 'u', 'versions' => []],
        ]])]);

        $this->getJson(route('api.v1.servers.mods.workshop.search', ['alfa', 'q' => 'calamity']))
            ->assertOk()
            ->assertJsonPath('data.0.subscriptions', 900000);

        $this->assertDatabaseHas('workshop_items', ['workshop_id' => '2824688072', 'mod_name' => 'CalamityMod', 'subscriptions' => 900000]);
    }

    public function test_agent_errors_are_relayed(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);
        Http::fake([self::AGENT_URL.'/workshop/search*' => Http::response(['error' => 'unavailable', 'message' => 'La ricerca nel Workshop richiede la chiave Steam Web API'], 503)]);

        $this->getJson(route('api.v1.servers.mods.workshop.search', ['alfa', 'q' => 'calamity']))
            ->assertStatus(502)
            ->assertJsonPath('message', 'La ricerca nel Workshop richiede la chiave Steam Web API');
    }

    public function test_browse_install_and_pending_endpoints_require_the_mods_ability(): void
    {
        $this->actingAsMember([ServerAbility::Files]);

        $this->getJson(route('api.v1.servers.mods.workshop.browse', 'alfa'))->assertForbidden();
        $this->getJson(route('api.v1.servers.mods.workshop.item', ['alfa', '2824688072']))->assertForbidden();
        $this->postJson(route('api.v1.servers.mods.workshop.install', 'alfa'), ['ids' => ['2824688072']])->assertForbidden();
        $this->getJson(route('api.v1.servers.mods.workshop.pending', 'alfa'))->assertForbidden();
        $this->postJson(route('api.v1.servers.mods.workshop.pending.apply', 'alfa'))->assertForbidden();
        $this->deleteJson(route('api.v1.servers.mods.workshop.pending.dismiss', ['alfa', 'CalamityMod']))->assertForbidden();

        Http::assertNothingSent();
    }

    public function test_browse_forwards_filters_and_stores_results(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);
        Http::fake([self::AGENT_URL.'/servers/alfa/workshop/browse*' => Http::response(['data' => [
            'tmlVersion' => '2026.9.3.1', 'total' => 1, 'nextCursor' => 'AoJ',
            'items' => [['id' => '2619954303', 'found' => true, 'title' => 'Recipe Browser', 'modName' => 'RecipeBrowser', 'tags' => ['Utilities'], 'previewUrl' => null, 'subscriptions' => 8551035, 'fileSize' => 1356461, 'timeUpdated' => null, 'url' => 'u', 'versions' => [], 'description' => 'x', 'compatibleVersion' => '0.11', 'requiresTml' => null, 'dependencies' => []]],
        ]])]);

        $this->getJson(route('api.v1.servers.mods.workshop.browse', ['alfa', 'sort' => 'trend', 'tag' => 'quality of life', 'q' => '', 'cursor' => 'abc+/=']))
            ->assertOk()
            ->assertJsonPath('data.nextCursor', 'AoJ')
            ->assertJsonPath('data.items.0.compatibleVersion', '0.11');

        $this->assertDatabaseHas('workshop_items', ['workshop_id' => '2619954303', 'mod_name' => 'RecipeBrowser']);
        Http::assertSent(fn (Request $request): bool => $request['sort'] === 'trend' && $request['tag'] === 'quality of life'
            && $request['cursor'] === 'abc+/=' && ! isset($request['q']));
    }

    public function test_browse_rejects_unknown_sorts(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);

        $this->getJson(route('api.v1.servers.mods.workshop.browse', ['alfa', 'sort' => 'random']))->assertUnprocessable();
        $this->getJson(route('api.v1.servers.mods.workshop.browse', ['alfa', 'tag' => '<script>']))->assertUnprocessable();

        Http::assertNothingSent();
    }

    public function test_installs_workshop_items(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);
        Http::fake([self::AGENT_URL.'/servers/alfa/workshop/install' => Http::response(['data' => ['state' => 'running', 'items' => []]], 202)]);

        $this->postJson(route('api.v1.servers.mods.workshop.install', 'alfa'), ['ids' => ['2619954303']])
            ->assertAccepted()
            ->assertJsonPath('data.state', 'running');
        // Add-on di tModManager (es. LiveMap): ID "tmm-<Nome>"
        $this->postJson(route('api.v1.servers.mods.workshop.install', 'alfa'), ['ids' => ['tmm-TmmLiveMap']])->assertAccepted();
        $this->postJson(route('api.v1.servers.mods.workshop.install', 'alfa'), ['ids' => ['abc']])->assertUnprocessable();
        $this->postJson(route('api.v1.servers.mods.workshop.install', 'alfa'), ['ids' => ['tmm-../x']])->assertUnprocessable();
        $this->postJson(route('api.v1.servers.mods.workshop.install', 'alfa'), ['ids' => []])->assertUnprocessable();

        Http::assertSentCount(2);
        Http::assertSent(fn (Request $request): bool => $request['ids'] === ['2619954303']);
        Http::assertSent(fn (Request $request): bool => $request['ids'] === ['tmm-TmmLiveMap']);
    }

    public function test_addon_items_are_shown_but_not_stored_as_steam_items(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);
        $addon = ['id' => 'tmm-TmmLiveMap', 'found' => true, 'title' => 'LiveMap', 'modName' => 'TmmLiveMap', 'tags' => ['Utilities'], 'previewUrl' => 'data:image/png;base64,AA==', 'subscriptions' => null, 'fileSize' => 36000, 'timeUpdated' => null, 'url' => '', 'versions' => [], 'description' => 'x', 'compatibleVersion' => '1.0', 'requiresTml' => null, 'dependencies' => [], 'addon' => true];
        Http::fake([
            self::AGENT_URL.'/servers/alfa/workshop/browse*' => Http::response(['data' => ['tmlVersion' => null, 'total' => 1, 'nextCursor' => null, 'items' => [$addon], 'steamError' => 'serve la chiave']]),
            self::AGENT_URL.'/servers/alfa/workshop/items/tmm-TmmLiveMap' => Http::response(['data' => [...$addon, 'images' => [], 'dependencyItems' => []]]),
        ]);

        $this->getJson(route('api.v1.servers.mods.workshop.browse', 'alfa'))
            ->assertOk()
            ->assertJsonPath('data.items.0.addon', true)
            ->assertJsonPath('data.steamError', 'serve la chiave');
        $this->getJson(route('api.v1.servers.mods.workshop.item', ['alfa', 'tmm-TmmLiveMap']))->assertOk()->assertJsonPath('data.title', 'LiveMap');
        $this->getJson('/api/v1/servers/alfa/workshop/items/tmm-..')->assertNotFound();

        $this->assertDatabaseCount('workshop_items', 0);
    }

    public function test_installs_missing_mods_by_name(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);
        Http::fake([self::AGENT_URL.'/servers/alfa/workshop/install-names' => Http::response(['data' => ['state' => 'running', 'items' => []]], 202)]);

        $this->postJson(route('api.v1.servers.mods.workshop.install-names', 'alfa'), ['names' => ['ThoriumMod']])->assertAccepted();
        $this->postJson(route('api.v1.servers.mods.workshop.install-names', 'alfa'), ['names' => ['non valido!']])->assertUnprocessable();

        Http::assertSentCount(1);
        Http::assertSent(fn (Request $request): bool => $request['names'] === ['ThoriumMod']);
    }

    public function test_pending_mods_are_listed_applied_and_dismissed(): void
    {
        $this->actingAsMember([ServerAbility::Mods]);
        Http::fake([
            self::AGENT_URL.'/servers/alfa/workshop/pending/apply' => Http::response(['data' => ['enabled' => ['RecipeBrowser'], 'failed' => []]]),
            self::AGENT_URL.'/servers/alfa/workshop/pending/RecipeBrowser' => Http::response(null, 204),
            self::AGENT_URL.'/servers/alfa/workshop/pending' => Http::response(['data' => [['name' => 'RecipeBrowser']]]),
        ]);

        $this->getJson(route('api.v1.servers.mods.workshop.pending', 'alfa'))->assertOk()->assertJsonPath('data.0.name', 'RecipeBrowser');
        $this->postJson(route('api.v1.servers.mods.workshop.pending.apply', 'alfa'))->assertOk()->assertJsonPath('data.enabled', ['RecipeBrowser']);
        $this->deleteJson(route('api.v1.servers.mods.workshop.pending.dismiss', ['alfa', 'RecipeBrowser']))->assertNoContent();

        Http::assertSent(fn (Request $request): bool => $request->method() === 'DELETE' && str_ends_with($request->url(), '/workshop/pending/RecipeBrowser'));
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
