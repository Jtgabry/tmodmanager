<?php

namespace App\Http\Controllers\Api\V1;

use App\Enums\ServerAbility;
use App\Http\Controllers\Controller;
use App\Http\Requests\SendConsoleCommandRequest;
use App\Services\Agent\AgentClient;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Log;

/**
 * Console del server: il client legge in polling passando l'offset ricevuto e invia comandi riga per riga.
 */
class ServerConsoleController extends Controller
{
    public function __construct(private readonly AgentClient $agent) {}

    public function show(Request $request, string $server): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Console]);

        $offset = $request->validate(['offset' => ['nullable', 'integer', 'min:0']])['offset'] ?? null;
        $offset = $offset === null ? null : (int) $offset;

        return response()->json(['data' => $this->agent->console($server, $offset)]);
    }

    public function store(SendConsoleCommandRequest $request, string $server): Response
    {
        Gate::authorize('server', [$server, ServerAbility::Console]);

        if ($request->shutsDownServer()) {
            Gate::authorize('server', [$server, ServerAbility::Power]);
        }

        $command = trim($request->validated('command'));
        $this->agent->sendCommand($server, $command);

        Log::info('Comando console', ['user' => $request->user()->email, 'server' => $server, 'command' => $command]);

        return response()->noContent();
    }
}
