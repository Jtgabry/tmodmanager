<?php

namespace App\Http\Controllers\Api\V1;

use App\Enums\ServerAbility;
use App\Http\Controllers\Controller;
use App\Http\Requests\ModpackRequest;
use App\Services\Agent\AgentClient;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Gate;
use Symfony\Component\HttpFoundation\StreamedResponse;

class ServerModpackController extends Controller
{
    public function __construct(private readonly AgentClient $agent) {}

    public function index(string $server): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        return response()->json(['data' => $this->agent->json('get', "/servers/{$server}/modpacks")]);
    }

    public function store(ModpackRequest $request, string $server): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        return response()->json(['data' => $this->agent->json('post', "/servers/{$server}/modpacks", $request->payload())], 201);
    }

    public function update(ModpackRequest $request, string $server, string $modpack): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        return response()->json(['data' => $this->agent->json('put', "/servers/{$server}/modpacks/{$modpack}", $request->payload())]);
    }

    public function destroy(string $server, string $modpack): Response
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        $this->agent->json('delete', "/servers/{$server}/modpacks/{$modpack}");

        return response()->noContent();
    }

    /**
     * Il pack come cartella di tModLoader (Mods/ + ModConfigs/) in .zip; il nome lo decide l'agent.
     */
    public function export(string $server, string $modpack): StreamedResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        return $this->agent->download("/servers/{$server}/modpacks/{$modpack}/export");
    }
}
