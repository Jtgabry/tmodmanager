<?php

namespace App\Http\Controllers\Api\V1;

use App\Enums\ServerAbility;
use App\Http\Controllers\Controller;
use App\Http\Requests\UploadModRequest;
use App\Services\Agent\AgentClient;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Log;

/**
 * Archivio delle versioni delle mod: versioni non installate, usate dai modpack con versione bloccata.
 * Si possono caricare a mano, eliminare o installare al posto di quella attuale.
 */
class ServerModArchiveController extends Controller
{
    public function __construct(private readonly AgentClient $agent) {}

    public function index(string $server): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        return response()->json(['data' => $this->agent->json('get', "/servers/{$server}/archive")]);
    }

    /**
     * Aggiunge a mano un .tmod all'archivio (la mod installata non cambia).
     */
    public function store(UploadModRequest $request, string $server): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        $result = $this->agent->upload("/servers/{$server}/archive", $request->file('file')->getRealPath());
        Log::info('Versione aggiunta all\'archivio', ['user' => $request->user()->email, 'server' => $server, 'mod' => $result['name'] ?? null, 'version' => $result['version'] ?? null]);

        return response()->json(['data' => $result], 201);
    }

    public function destroy(Request $request, string $server, string $mod, string $version): Response
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        $this->agent->json('delete', "/servers/{$server}/archive/{$mod}/{$version}");
        Log::info('Versione eliminata dall\'archivio', ['user' => $request->user()->email, 'server' => $server, 'mod' => $mod, 'version' => $version]);

        return response()->noContent();
    }

    /**
     * Installa la versione archiviata al posto di quella attuale (che entra nell'archivio).
     */
    public function use(Request $request, string $server, string $mod, string $version): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        $result = $this->agent->json('post', "/servers/{$server}/archive/{$mod}/{$version}/use", timeout: 60);
        Log::info('Versione presa dall\'archivio', ['user' => $request->user()->email, 'server' => $server, 'mod' => $mod, 'version' => $version]);

        return response()->json(['data' => $result]);
    }
}
