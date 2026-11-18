<?php

namespace App\Http\Controllers\Api\V1;

use App\Enums\ServerAbility;
use App\Http\Controllers\Controller;
use App\Http\Requests\UploadPluginRequest;
use App\Services\Agent\AgentClient;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Log;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * Plugin di un server TShock: elenco, caricamento (.dll), versioni salvate, attivazione, eliminazione.
 * Stesso permesso delle mod.
 */
class ServerPluginController extends Controller
{
    public function __construct(private readonly AgentClient $agent) {}

    public function index(string $server): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        return response()->json(['data' => $this->agent->json('get', "/servers/{$server}/plugins")]);
    }

    /**
     * Carica una .dll: diventa la versione scelta del plugin, le versioni precedenti restano salvate.
     */
    public function store(UploadPluginRequest $request, string $server): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        $file = $request->file('file');
        $result = $this->agent->upload("/servers/{$server}/plugins", $file->getRealPath(), [
            'filename' => $file->getClientOriginalName(),
            'enable' => $request->boolean('enable') ? '1' : '0',
        ]);

        Log::info('Plugin caricato', [
            'user' => $request->user()->email,
            'server' => $server,
            'plugin' => $result['plugin']['name'] ?? null,
            'version' => $result['versionId'] ?? null,
        ]);

        return response()->json(['data' => $result], ($result['duplicate'] ?? false) ? 200 : 201);
    }

    public function update(Request $request, string $server, string $plugin): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        $data = $request->validate(['enabled' => ['required', 'boolean']]);

        return response()->json(['data' => $this->agent->json('patch', "/servers/{$server}/plugins/{$plugin}", [
            'enabled' => (bool) $data['enabled'],
        ])]);
    }

    /**
     * Plugin intero (tutte le versioni) nel cestino.
     */
    public function destroy(Request $request, string $server, string $plugin): Response
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        $this->agent->json('delete', "/servers/{$server}/plugins/{$plugin}");
        Log::info('Plugin eliminato', ['user' => $request->user()->email, 'server' => $server, 'plugin' => $plugin]);

        return response()->noContent();
    }

    public function useVersion(string $server, string $plugin, string $pluginVersion): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        return response()->json(['data' => $this->agent->json('post', "/servers/{$server}/plugins/{$plugin}/versions/{$pluginVersion}/use")]);
    }

    public function destroyVersion(Request $request, string $server, string $plugin, string $pluginVersion): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        $result = $this->agent->json('delete', "/servers/{$server}/plugins/{$plugin}/versions/{$pluginVersion}");
        Log::info('Versione di un plugin eliminata', ['user' => $request->user()->email, 'server' => $server, 'plugin' => $plugin, 'version' => $pluginVersion]);

        return response()->json(['data' => $result]);
    }

    /**
     * Tutte le versioni tranne quella scelta, nel cestino.
     */
    public function destroyOldVersions(Request $request, string $server, string $plugin): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        $result = $this->agent->json('delete', "/servers/{$server}/plugins/{$plugin}/versions");
        Log::info('Versioni vecchie di un plugin eliminate', ['user' => $request->user()->email, 'server' => $server, 'plugin' => $plugin]);

        return response()->json(['data' => $result]);
    }

    public function download(string $server, string $plugin, string $pluginVersion): StreamedResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        return $this->agent->download("/servers/{$server}/plugins/{$plugin}/versions/{$pluginVersion}/download", "{$plugin}.dll");
    }
}
