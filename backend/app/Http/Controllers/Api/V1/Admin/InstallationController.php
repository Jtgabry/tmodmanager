<?php

namespace App\Http\Controllers\Api\V1\Admin;

use App\Http\Controllers\Controller;
use App\Http\Requests\Admin\StoreInstallationVersionRequest;
use App\Http\Requests\Admin\UpdateInstallationRequest;
use App\Services\Agent\AgentClient;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;

/**
 * Installazioni di Terraria vanilla, TShock e tModLoader (solo admin): versione, server che le usano, backup e
 * aggiornamento (Terraria da terraria.org, TShock e tModLoader da GitHub).
 */
class InstallationController extends Controller
{
    public function __construct(private readonly AgentClient $agent) {}

    public function index(): JsonResponse
    {
        return response()->json(['data' => $this->agent->json('get', '/admin/installations')]);
    }

    /**
     * Avvisi del controllo giornaliero degli aggiornamenti (fatto dall'agent al massimo una volta al giorno):
     * installazioni da aggiornare, Terraria uscito prima di TShock, server che possono tornare su TShock.
     */
    public function updates(): JsonResponse
    {
        return response()->json(['data' => $this->agent->json('get', '/admin/updates')]);
    }

    /**
     * Versioni disponibili di Terraria (terraria.org), TShock o tModLoader (GitHub), in cache nell'agent per 10 minuti.
     */
    public function releases(Request $request, string $game): JsonResponse
    {
        $query = $request->boolean('refresh') ? ['refresh' => '1'] : [];

        return response()->json(['data' => $this->agent->json('get', "/admin/releases/{$game}", $query, timeout: 30)]);
    }

    /**
     * Avvia l'aggiornamento (o il ritorno a un backup): prosegue in background nell'agent.
     */
    public function update(UpdateInstallationRequest $request, string $installation): JsonResponse
    {
        $payload = $request->payload();
        $job = $this->agent->json('post', "/admin/installations/{$installation}/update", $payload, timeout: 30);
        Log::info('Aggiornamento installazione avviato', ['user' => $request->user()->email, 'installation' => $installation, ...$payload]);

        return response()->json(['data' => $job], 202);
    }

    /**
     * Aggiunge una versione fissa di Terraria, TShock o tModLoader (ogni server può stare su una versione sua):
     * l'installazione prosegue in background nell'agent.
     */
    public function storeVersion(StoreInstallationVersionRequest $request, string $game): JsonResponse
    {
        $version = $request->validated('version');
        $job = $this->agent->json('post', "/admin/installations/{$game}/versions", ['version' => $version], timeout: 30);
        Log::info('Versione fissa aggiunta', ['user' => $request->user()->email, 'game' => $game, 'version' => $version]);

        return response()->json(['data' => $job], 202);
    }

    /**
     * Rimuove una versione fissa (nessun server deve usarla).
     */
    public function destroy(Request $request, string $installation): JsonResponse
    {
        $result = $this->agent->json('delete', "/admin/installations/{$installation}", timeout: 60);
        Log::info('Versione fissa rimossa', ['user' => $request->user()->email, 'installation' => $installation]);

        return response()->json(['data' => $result]);
    }
}
