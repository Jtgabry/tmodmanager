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
 * Mappa del mondo (sezione "Mondo"): basta l'accesso al server. Sorgenti: l'add-on LiveMap (TShock e tModLoader,
 * in tempo reale, con i dati delle tile per gli sprite) o il file del mondo (tutti i server, a ogni salvataggio).
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
    public function chunk(string $server, string $source, int $cx, int $cy): Response
    {
        Gate::authorize('server', [$server, ServerAbility::View]);

        return $this->image("/servers/{$server}/map/{$source}/chunks/{$cx}/{$cy}");
    }

    public function overview(string $server, string $source): Response
    {
        Gate::authorize('server', [$server, ServerAbility::View]);

        return $this->image("/servers/{$server}/map/{$source}/overview");
    }

    /**
     * Dati grezzi delle tile di un riquadro di LiveMap (gzip, li decomprime il browser), per disegnare i blocchi
     * con i loro sprite da vicino. Come i riquadri, l'indirizzo contiene la versione.
     */
    public function tiles(string $server, int $cx, int $cy): Response
    {
        Gate::authorize('server', [$server, ServerAbility::View]);

        return $this->binary("/servers/{$server}/map/livemap/tiles/{$cx}/{$cy}", 'application/octet-stream');
    }

    /**
     * Tipi di blocchi e muri di LiveMap (quali sono delle mod, con quale texture). Cambiano a ogni avvio del server:
     * l'indirizzo contiene la versione.
     */
    public function types(string $server): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::View]);

        return response()
            ->json(['data' => $this->agent->json('get', "/servers/{$server}/map/livemap/types")])
            ->header('Cache-Control', 'private, max-age=31536000, immutable');
    }

    /**
     * Sprite di un tipo di blocco o di muro delle mod, preso dal suo .tmod.
     */
    public function sprite(string $server, string $kind, int $type): Response
    {
        Gate::authorize('server', [$server, ServerAbility::View]);

        return $this->image("/servers/{$server}/map/sprites/{$kind}/{$type}");
    }

    private function image(string $path): Response
    {
        return $this->binary($path, 'image/png');
    }

    private function binary(string $path, string $contentType): Response
    {
        return response($this->agent->stream($path)->body(), 200, [
            'Content-Type' => $contentType,
            'Cache-Control' => 'private, max-age=31536000, immutable',
            'X-Content-Type-Options' => 'nosniff',
        ]);
    }
}
