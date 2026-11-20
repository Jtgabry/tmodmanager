<?php

namespace App\Http\Controllers\Api\V1;

use App\Enums\ServerAbility;
use App\Http\Controllers\Controller;
use App\Services\Agent\AgentClient;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\ValidationException;

/**
 * Mappa del mondo (sezione "Mondo"): basta l'accesso al server; l'editor del mondo vuole la console. Sorgenti:
 * l'add-on LiveMap (TShock e tModLoader, in tempo reale, con i dati delle tile per gli sprite) o il file del mondo
 * (tutti i server, a ogni salvataggio).
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
     * Dati grezzi delle tile di un riquadro (gzip, li decomprime il browser), per disegnare i blocchi con i loro
     * sprite da vicino: da LiveMap o ricavati dal file del mondo. Come i riquadri, l'indirizzo contiene la versione.
     */
    public function tiles(string $server, string $source, int $cx, int $cy): Response
    {
        Gate::authorize('server', [$server, ServerAbility::View]);

        return $this->binary("/servers/{$server}/map/{$source}/tiles/{$cx}/{$cy}", 'application/octet-stream');
    }

    /**
     * Tipi di blocchi e muri della sorgente (quali sono delle mod, e di quale). Cambiano a ogni avvio del server o
     * salvataggio del mondo: l'indirizzo contiene la versione.
     */
    public function types(string $server, string $source): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::View]);

        return response()
            ->json(['data' => $this->agent->json('get', "/servers/{$server}/map/{$source}/types")])
            ->header('Cache-Control', 'private, max-age=31536000, immutable');
    }

    /**
     * Sprite di un tipo di blocco o di muro: di Terraria (dalle texture del gioco) o di una mod (dal suo .tmod).
     */
    public function sprite(string $server, string $source, string $kind, int $type): Response
    {
        Gate::authorize('server', [$server, ServerAbility::View]);

        return $this->image("/servers/{$server}/map/{$source}/sprites/{$kind}/{$type}");
    }

    /**
     * Blocchi e muri che l'editor del mondo può piazzare (dalla mod LiveMap, a ogni caricamento del mondo).
     */
    public function editorCatalog(string $server): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Console]);

        return response()->json(['data' => $this->agent->json('get', "/servers/{$server}/map/editor/catalog")]);
    }

    /**
     * Modifica il mondo a server acceso (blocchi e muri, tramite la mod LiveMap): chi ha la console può già
     * cambiare il mondo con i comandi, quindi serve lo stesso permesso. La validazione fine la fa l'agent.
     */
    public function edit(Request $request, string $server): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Console]);

        $validated = $request->validate([
            'ops' => ['required', 'array', 'min:1', 'max:4096'],
            'ops.*.op' => ['required', 'string', 'in:place-tile,kill-tile,place-wall,kill-wall'],
            'ops.*.x' => ['required', 'integer', 'min:0'],
            'ops.*.y' => ['required', 'integer', 'min:0'],
            'ops.*.type' => ['nullable', 'integer', 'min:0'],
            'ops.*.style' => ['nullable', 'integer', 'min:0'],
        ]);
        $ops = array_map(fn (array $op): array => array_filter($op, fn (mixed $value): bool => $value !== null), $validated['ops']);

        return response()->json(['data' => $this->agent->json('post', "/servers/{$server}/map/editor", ['ops' => $ops])]);
    }

    /**
     * Settaggi del mondo come li vede la mod LiveMap adesso (ora, meteo, eventi, difficoltà, spawn, boss sconfitti).
     */
    public function worldSettings(string $server): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Console]);

        return response()->json(['data' => $this->agent->json('get', "/servers/{$server}/map/editor/world")]);
    }

    /**
     * Cambia i settaggi del mondo indicati, a server acceso. Le regole di gioco (luna di sangue solo di notte, mondi
     * Viaggio, …) le controlla la mod: l'esito dice cosa non è cambiato e perché.
     */
    public function changeWorldSettings(Request $request, string $server): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Console]);

        $validated = $request->validate([
            'clock' => ['sometimes', 'integer', 'between:0,1439'],
            'rain' => ['sometimes', 'boolean'],
            'sandstorm' => ['sometimes', 'boolean'],
            'bloodMoon' => ['sometimes', 'boolean'],
            'eclipse' => ['sometimes', 'boolean'],
            'moonPhase' => ['sometimes', 'integer', 'between:0,7'],
            'gameMode' => ['sometimes', 'integer', 'between:0,2'],
            'hardMode' => ['sometimes', 'boolean'],
            'spawn' => ['sometimes', 'array:x,y'],
            'spawn.x' => ['required_with:spawn', 'integer', 'min:0'],
            'spawn.y' => ['required_with:spawn', 'integer', 'min:0'],
            'bosses' => ['sometimes', 'array'],
            'bosses.*' => ['boolean'],
        ]);
        if ($validated === []) {
            throw ValidationException::withMessages(['settings' => __('No setting to change.')]);
        }

        return response()->json(['data' => $this->agent->json('post', "/servers/{$server}/map/editor/settings", $validated)]);
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
