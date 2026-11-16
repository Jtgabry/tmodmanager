<?php

namespace App\Http\Controllers\Api\V1;

use App\Enums\ServerAbility;
use App\Http\Controllers\Controller;
use App\Http\Resources\ServerResource;
use App\Services\Agent\AgentClient;
use App\Services\Agent\ServerPowerAction;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Gate;

/**
 * Accensione, spegnimento e riavvio. Risponde 202: l'operazione continua in background
 * e il client segue lo stato con GET /servers/{server}.
 */
class ServerPowerController extends Controller
{
    public function __invoke(AgentClient $agent, string $server, ServerPowerAction $action): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Power]);

        return (new ServerResource($agent->power($server, $action)))
            ->response()
            ->setStatusCode(202);
    }
}
