<?php

namespace App\Http\Controllers\Api\V1;

use App\Enums\ServerAbility;
use App\Http\Controllers\Controller;
use App\Services\Agent\AgentClient;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Log;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * Backup dei mondi di un server (permesso "backups"): elenco con l'orario del backup automatico,
 * backup manuale, download dello .zip, ripristino, eliminazione. I backup stanno nell'agent.
 */
class ServerBackupController extends Controller
{
    public function __construct(private readonly AgentClient $agent) {}

    public function index(string $server): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Backups]);

        return response()->json(['data' => $this->agent->json('get', "/servers/{$server}/backups")]);
    }

    /**
     * Con il server acceso l'agent prima gli fa salvare il mondo (fino a un minuto).
     */
    public function store(Request $request, string $server): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Backups]);
        $result = $this->agent->json('post', "/servers/{$server}/backups", timeout: 180);
        Log::info('Backup del mondo', ['user' => $request->user()->email, 'server' => $server, 'backup' => $result['backup']['name'] ?? null]);

        return response()->json(['data' => $result], 201);
    }

    public function download(string $server, string $backup): StreamedResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Backups]);

        return $this->agent->download("/servers/{$server}/backups/{$backup}/download", $backup);
    }

    /**
     * Ripristina un backup (server spento): il mondo attuale finisce nel cestino del server.
     */
    public function restore(Request $request, string $server, string $backup): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Backups]);
        $result = $this->agent->json('post', "/servers/{$server}/backups/{$backup}/restore", timeout: 300);
        Log::info('Backup del mondo ripristinato', ['user' => $request->user()->email, 'server' => $server, 'backup' => $backup]);

        return response()->json(['data' => $result]);
    }

    public function destroy(Request $request, string $server, string $backup): Response
    {
        Gate::authorize('server', [$server, ServerAbility::Backups]);
        $this->agent->json('delete', "/servers/{$server}/backups/{$backup}");
        Log::info('Backup del mondo eliminato', ['user' => $request->user()->email, 'server' => $server, 'backup' => $backup]);

        return response()->noContent();
    }
}
