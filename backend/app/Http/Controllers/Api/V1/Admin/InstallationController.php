<?php

namespace App\Http\Controllers\Api\V1\Admin;

use App\Http\Controllers\Controller;
use App\Http\Requests\Admin\UpdateInstallationRequest;
use App\Services\Agent\AgentClient;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;

/**
 * Installazioni di tModLoader (solo admin): versione, server che le usano, backup e aggiornamento da GitHub.
 */
class InstallationController extends Controller
{
    public function __construct(private readonly AgentClient $agent) {}

    public function index(): JsonResponse
    {
        return response()->json(['data' => $this->agent->json('get', '/admin/installations')]);
    }

    /**
     * Release di tModLoader pubblicate su GitHub (in cache nell'agent per 10 minuti).
     */
    public function releases(Request $request): JsonResponse
    {
        $query = $request->boolean('refresh') ? ['refresh' => '1'] : [];

        return response()->json(['data' => $this->agent->json('get', '/admin/tml/releases', $query, timeout: 30)]);
    }

    /**
     * Avvia l'aggiornamento (o il ritorno a un backup): prosegue in background nell'agent.
     */
    public function update(UpdateInstallationRequest $request, string $installation): JsonResponse
    {
        $payload = $request->payload();
        $job = $this->agent->json('post', "/admin/installations/{$installation}/update", $payload, timeout: 30);
        Log::info('Aggiornamento tModLoader avviato', ['user' => $request->user()->email, 'installation' => $installation, ...$payload]);

        return response()->json(['data' => $job], 202);
    }
}
