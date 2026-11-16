<?php

namespace App\Http\Controllers\Api\V1;

use App\Enums\ServerAbility;
use App\Http\Controllers\Controller;
use App\Services\Agent\AgentClient;
use App\Services\Workshop\WorkshopCatalog;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Log;

/**
 * Mod dallo Steam Workshop: controllo degli aggiornamenti, aggiornamento (download con steamcmd
 * nell'agent), collegamento manuale di una mod alla sua pagina, ricerca, navigazione del Workshop
 * e installazione di mod nuove (che restano in attesa finché non si abilitano tutte insieme).
 * La chiave Steam Web API resta nell'agent: Laravel non la vede mai.
 */
class ServerModWorkshopController extends Controller
{
    public function __construct(
        private readonly AgentClient $agent,
        private readonly WorkshopCatalog $catalog,
    ) {}

    /**
     * Stato degli aggiornamenti di tutte le mod del server.
     */
    public function index(Request $request, string $server): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        $query = $request->boolean('refresh') ? ['refresh' => '1'] : [];

        // Al primo controllo l'agent cerca nel Workshop tutte le mod: può volerci qualche secondo
        $report = $this->agent->json('get', "/servers/{$server}/mods/updates", $query, timeout: 120);
        $this->catalog->remember($report['items'] ?? []);
        unset($report['items']);

        return response()->json(['data' => $report]);
    }

    /**
     * Avvia l'aggiornamento delle mod indicate (prosegue in background nell'agent).
     */
    public function store(Request $request, string $server): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        $data = $request->validate([
            'mods' => ['required', 'array', 'min:1', 'max:200'],
            'mods.*' => ['required', 'string', 'distinct', 'regex:/^[A-Za-z0-9_]{1,64}$/'],
        ]);

        $job = $this->agent->json('post', "/servers/{$server}/mods/updates", ['mods' => array_values($data['mods'])], timeout: 30);
        Log::info('Aggiornamento mod dal Workshop avviato', ['user' => $request->user()->email, 'server' => $server, 'mods' => $data['mods']]);

        return response()->json(['data' => $job], 202);
    }

    /**
     * Ultimo aggiornamento avviato su questo server (in corso o concluso), oppure null.
     */
    public function job(string $server): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        return response()->json(['data' => $this->agent->json('get', "/servers/{$server}/mods/updates/job")]);
    }

    /**
     * Annulla il download di una mod del lavoro in corso (le altre proseguono).
     */
    public function cancel(Request $request, string $server, string $mod): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        $job = $this->agent->json('delete', "/servers/{$server}/mods/updates/job/{$mod}");
        Log::info('Download dal Workshop annullato', ['user' => $request->user()->email, 'server' => $server, 'mod' => $mod]);

        return response()->json(['data' => $job]);
    }

    /**
     * Collega a mano la mod a una pagina del Workshop (link o ID), oppure la segna come "non nel Workshop" (null).
     */
    public function link(Request $request, string $server, string $mod): Response
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        $data = $request->validate(['workshop' => ['present', 'nullable', 'string', 'max:300']]);
        $item = $this->agent->json('put', "/servers/{$server}/mods/{$mod}/workshop", ['workshop' => $data['workshop']], timeout: 30);
        if (is_array($item)) {
            $this->catalog->remember([$item]);
        }

        return response()->noContent();
    }

    /**
     * Toglie il collegamento manuale: la mod torna a essere riconosciuta in automatico.
     */
    public function unlink(string $server, string $mod): Response
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        $this->agent->json('delete', "/servers/{$server}/mods/{$mod}/workshop");

        return response()->noContent();
    }

    /**
     * Ricerca nel Workshop di tModLoader (per collegare una mod a mano).
     */
    public function search(Request $request, string $server): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        $data = $request->validate(['q' => ['required', 'string', 'min:2', 'max:100']]);

        $results = $this->agent->json('get', '/workshop/search', ['q' => $data['q']], timeout: 30);
        $this->catalog->remember($results ?? []);

        return response()->json(['data' => $results]);
    }

    /**
     * Una pagina di risultati del Workshop (ordinamento, tag, ricerca; si prosegue con `cursor`).
     */
    public function browse(Request $request, string $server): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        $data = $request->validate([
            'q' => ['nullable', 'string', 'max:100'],
            'sort' => ['nullable', 'string', 'in:relevance,popular,trend,recent,updated,votes'],
            'tag' => ['nullable', 'string', 'max:64', "regex:/^[\\w .&'-]+$/"],
            'cursor' => ['nullable', 'string', 'max:200'],
        ]);

        $page = $this->agent->json('get', "/servers/{$server}/workshop/browse", array_filter($data, fn ($v): bool => $v !== null && $v !== ''), timeout: 30);
        $this->catalog->remember($page['items'] ?? []);

        return response()->json(['data' => $page]);
    }

    /**
     * Pagina completa di un elemento del Workshop: descrizione, immagini, dipendenze dichiarate.
     */
    public function item(string $server, string $workshopItem): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        $item = $this->agent->json('get', "/servers/{$server}/workshop/items/{$workshopItem}", timeout: 30);
        if (is_array($item)) {
            $this->catalog->remember([$item]);
        }

        return response()->json(['data' => $item]);
    }

    /**
     * Installa dal Workshop gli elementi indicati. Se c'è già un download in corso si mettono in coda.
     */
    public function install(Request $request, string $server): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        $data = $request->validate([
            'ids' => ['required', 'array', 'min:1', 'max:50'],
            'ids.*' => ['required', 'string', 'distinct', 'regex:/^\\d{1,20}$/'],
        ]);

        $job = $this->agent->json('post', "/servers/{$server}/workshop/install", ['ids' => array_values($data['ids'])], timeout: 30);
        Log::info('Installazione mod dal Workshop', ['user' => $request->user()->email, 'server' => $server, 'ids' => $data['ids']]);

        return response()->json(['data' => $job], 202);
    }

    /**
     * Installa dal Workshop le mod indicate per nome interno (es. quelle che mancano a un modpack).
     */
    public function installNames(Request $request, string $server): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        $data = $request->validate([
            'names' => ['required', 'array', 'min:1', 'max:50'],
            'names.*' => ['required', 'string', 'distinct', 'regex:/^[A-Za-z0-9_]{1,64}$/'],
        ]);

        $job = $this->agent->json('post', "/servers/{$server}/workshop/install-names", ['names' => array_values($data['names'])], timeout: 60);
        Log::info('Installazione mod dal Workshop per nome', ['user' => $request->user()->email, 'server' => $server, 'names' => $data['names']]);

        return response()->json(['data' => $job], 202);
    }

    /**
     * Mod installate dal Workshop e non ancora abilitate.
     */
    public function pending(string $server): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        return response()->json(['data' => $this->agent->json('get', "/servers/{$server}/workshop/pending")]);
    }

    /**
     * Abilita tutte insieme le mod in attesa (il riavvio lo chiede il sito subito dopo).
     */
    public function applyPending(Request $request, string $server): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        $result = $this->agent->json('post', "/servers/{$server}/workshop/pending/apply", timeout: 30);
        Log::info('Abilitate le mod installate dal Workshop', ['user' => $request->user()->email, 'server' => $server, 'enabled' => $result['enabled'] ?? []]);

        return response()->json(['data' => $result]);
    }

    /**
     * Toglie una mod dall'elenco di quelle in attesa (resta installata e disabilitata).
     */
    public function dismissPending(string $server, string $mod): Response
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        $this->agent->json('delete', "/servers/{$server}/workshop/pending/{$mod}");

        return response()->noContent();
    }
}
