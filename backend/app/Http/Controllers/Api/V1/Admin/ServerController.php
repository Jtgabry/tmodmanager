<?php

namespace App\Http\Controllers\Api\V1\Admin;

use App\Http\Controllers\Controller;
use App\Http\Requests\Admin\StoreServerRequest;
use App\Http\Requests\Admin\UpdateServerRequest;
use App\Models\ServerAccess;
use App\Services\Agent\AgentClient;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;

/**
 * Gestione dei server (solo admin): creazione, impostazioni, rimozione dal pannello.
 * Il registry dei server sta nell'agent; qui si tengono solo i permessi degli utenti.
 */
class ServerController extends Controller
{
    public function __construct(private readonly AgentClient $agent) {}

    /**
     * Valori suggeriti per il form di creazione (prima porta libera, installazioni di Terraria e tModLoader).
     */
    public function defaults(): JsonResponse
    {
        return response()->json(['data' => $this->agent->json('get', '/admin/servers/defaults')]);
    }

    public function store(StoreServerRequest $request): JsonResponse
    {
        $result = $this->agent->json('post', '/admin/servers', $request->payload(), timeout: 300);
        Log::info('Server creato', ['user' => $request->user()->email, 'server' => $result['id'] ?? null]);

        return response()->json(['data' => $result], 201);
    }

    public function show(string $server): JsonResponse
    {
        return response()->json(['data' => $this->agent->json('get', "/admin/servers/{$server}")]);
    }

    public function update(UpdateServerRequest $request, string $server): JsonResponse
    {
        $payload = $request->payload();
        $result = $this->agent->json('patch', "/admin/servers/{$server}", $payload);
        Log::info('Impostazioni server modificate', [
            'user' => $request->user()->email,
            'server' => $server,
            'fields' => array_keys($payload),
        ]);

        return response()->json(['data' => $result]);
    }

    /**
     * Ricrea il mondo da capo (server spento): il mondo attuale va nel cestino del server e al prossimo
     * avvio ne viene generato uno nuovo con le impostazioni del serverconfig.
     */
    public function recreateWorld(Request $request, string $server): JsonResponse
    {
        $result = $this->agent->json('post', "/admin/servers/{$server}/world/recreate", timeout: 60);
        Log::info('Mondo ricreato', ['user' => $request->user()->email, 'server' => $server]);

        return response()->json(['data' => $result]);
    }

    /**
     * Toglie il server dal pannello (deve essere spento). I file del server restano su disco.
     */
    public function destroy(Request $request, string $server): JsonResponse
    {
        $result = $this->agent->json('delete', "/admin/servers/{$server}");
        ServerAccess::query()->where('server_id', $server)->delete();
        Log::info('Server rimosso dal pannello', ['user' => $request->user()->email, 'server' => $server]);

        return response()->json(['data' => $result]);
    }
}
