<?php

namespace App\Http\Controllers\Api\V1;

use App\Enums\ServerAbility;
use App\Http\Controllers\Controller;
use App\Services\Agent\AgentClient;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Gate;

/**
 * Mappa del mondo (sezione "Mondo"): basta l'accesso al server.
 */
class ServerMapController extends Controller
{
    public function __construct(private readonly AgentClient $agent) {}

    /**
     * Stato della mappa. Con watching=1 (pagina aperta) l'agent segnala a LiveMap di aggiornarla.
     */
    public function show(Request $request, string $server): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::View]);

        return response()->json(['data' => $this->agent->json('get', "/servers/{$server}/map", [
            'watching' => $request->boolean('watching') ? '1' : '0',
        ])]);
    }

    /**
     * Riquadro della mappa. Il frontend mette la versione nell'indirizzo: quando il riquadro cambia, cambia
     * l'indirizzo, quindi il browser può tenerlo in cache a lungo.
     */
    public function chunk(string $server, int $cx, int $cy): Response
    {
        Gate::authorize('server', [$server, ServerAbility::View]);

        return $this->image("/servers/{$server}/map/chunks/{$cx}/{$cy}");
    }

    public function overview(string $server): Response
    {
        Gate::authorize('server', [$server, ServerAbility::View]);

        return $this->image("/servers/{$server}/map/overview");
    }

    private function image(string $path): Response
    {
        return response($this->agent->stream($path)->body(), 200, [
            'Content-Type' => 'image/png',
            'Cache-Control' => 'private, max-age=31536000, immutable',
            'X-Content-Type-Options' => 'nosniff',
        ]);
    }
}
