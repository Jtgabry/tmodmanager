<?php

namespace App\Http\Controllers\Api\V1;

use App\Enums\ServerAbility;
use App\Http\Controllers\Controller;
use App\Http\Resources\ServerResource;
use App\Services\Agent\AgentClient;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\AnonymousResourceCollection;
use Illuminate\Support\Facades\Gate;

class ServerController extends Controller
{
    public function __construct(private readonly AgentClient $agent) {}

    /**
     * Solo i server su cui l'utente ha almeno il permesso "view" (gli admin li vedono tutti).
     */
    public function index(Request $request): AnonymousResourceCollection
    {
        $user = $request->user();
        $servers = array_values(array_filter(
            $this->agent->servers(),
            fn (array $server): bool => $user->can('server', [$server['id'], ServerAbility::View]),
        ));

        return ServerResource::collection($servers);
    }

    public function show(string $server): ServerResource
    {
        Gate::authorize('server', [$server, ServerAbility::View]);

        return new ServerResource($this->agent->server($server));
    }
}
