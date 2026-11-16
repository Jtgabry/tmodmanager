<?php

namespace App\Http\Controllers\Api\V1;

use App\Enums\ServerAbility;
use App\Http\Controllers\Controller;
use App\Http\Requests\ImportModpackRequest;
use App\Services\Agent\AgentClient;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Log;

/**
 * Importazione dei modpack di tModLoader: diventano modpack del pannello (le mod incluse vengono installate).
 */
class ServerModpackImportController extends Controller
{
    public function __construct(private readonly AgentClient $agent) {}

    /**
     * Pack presenti nella cartella Mods/ModPacks del server.
     */
    public function index(string $server): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        return response()->json(['data' => $this->agent->json('get', "/servers/{$server}/modpacks/importable")]);
    }

    public function store(ImportModpackRequest $request, string $server): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        $replace = $request->boolean('replaceExisting');
        $file = $request->file('file');

        $result = $file !== null
            ? $this->agent->upload("/servers/{$server}/modpacks/import", $file->getRealPath(), [
                'filename' => $file->getClientOriginalName(),
                'replaceExisting' => $replace ? '1' : '0',
            ])
            : $this->agent->json('post', "/servers/{$server}/modpacks/import", [
                'name' => $request->validated('name'),
                'replaceExisting' => $replace,
            ], timeout: 600);

        Log::info('Modpack importato', [
            'user' => $request->user()->email,
            'server' => $server,
            'pack' => $result['pack']['name'] ?? null,
            'installed' => $result['installed'] ?? [],
            'updated' => $result['updated'] ?? [],
        ]);

        return response()->json(['data' => $result], 201);
    }
}
