<?php

namespace App\Http\Controllers\Api\V1;

use App\Enums\ServerAbility;
use App\Http\Controllers\Controller;
use App\Services\Agent\AgentClient;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;

/**
 * Attivazione di un modpack (POST) e disattivazione (DELETE).
 * Con `exclusive` l'attivazione lascia abilitate solo le mod del pack (e le loro dipendenze).
 */
class ServerModpackActivationController extends Controller
{
    public function __construct(private readonly AgentClient $agent) {}

    public function store(Request $request, string $server, string $modpack): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        $data = $request->validate(['exclusive' => ['sometimes', 'boolean']]);
        $payload = ($data['exclusive'] ?? false) ? ['exclusive' => true] : [];

        return response()->json(['data' => $this->agent->json('post', "/servers/{$server}/modpacks/{$modpack}/enable", $payload, timeout: 120)]);
    }

    public function destroy(string $server, string $modpack): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        return response()->json(['data' => $this->agent->json('post', "/servers/{$server}/modpacks/{$modpack}/disable")]);
    }
}
