<?php

namespace App\Http\Controllers\Api\V1;

use App\Enums\ServerAbility;
use App\Http\Controllers\Controller;
use App\Http\Requests\UploadModRequest;
use App\Services\Agent\AgentClient;
use App\Services\Workshop\WorkshopCatalog;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Log;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * Mod di un server: elenco, caricamento/aggiornamento (.tmod), abilitazione, eliminazione, download.
 */
class ServerModController extends Controller
{
    public function __construct(private readonly AgentClient $agent) {}

    /**
     * Elenco delle mod, con i dati della pagina del Workshop (tag, anteprima…) presi dal database.
     */
    public function index(string $server, WorkshopCatalog $catalog): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        $data = $this->agent->json('get', "/servers/{$server}/mods");
        $mods = $data['mods'] ?? [];
        $items = $catalog->forIds(array_values(array_filter(array_column($mods, 'workshopId'))));

        $data['mods'] = array_map(function (array $mod) use ($items): array {
            $item = $items->get($mod['workshopId'] ?? '');
            $mod['workshop'] = $item?->found ? $item->summary() : null;

            return $mod;
        }, $mods);

        return response()->json(['data' => $data]);
    }

    /**
     * Carica una mod nuova o aggiorna quella con lo stesso nome interno (la vecchia va in backup).
     */
    public function store(UploadModRequest $request, string $server): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        $result = $this->agent->upload(
            "/servers/{$server}/mods",
            $request->file('file')->getRealPath(),
            ['enable' => $request->boolean('enable') ? '1' : '0'],
        );

        Log::info('Mod caricata', [
            'user' => $request->user()->email,
            'server' => $server,
            'mod' => $result['mod']['name'] ?? null,
            'version' => $result['mod']['version'] ?? null,
            'replaced' => $result['replacedVersion'] ?? null,
        ]);

        return response()->json(['data' => $result], ($result['replacedVersion'] ?? null) ? 200 : 201);
    }

    public function update(Request $request, string $server, string $mod): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        $data = $request->validate([
            'enabled' => ['required', 'boolean'],
            'cascade' => ['sometimes', 'boolean'],
        ]);

        return response()->json(['data' => $this->agent->json('patch', "/servers/{$server}/mods/{$mod}", [
            'enabled' => (bool) $data['enabled'],
            'cascade' => (bool) ($data['cascade'] ?? false),
        ])]);
    }

    public function destroy(Request $request, string $server, string $mod): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        $result = $this->agent->json('delete', "/servers/{$server}/mods/{$mod}", ['cascade' => $request->boolean('cascade') ? '1' : '0']);
        Log::info('Mod eliminata', ['user' => $request->user()->email, 'server' => $server, 'mod' => $mod]);

        return response()->json(['data' => $result]);
    }

    /**
     * Icona della mod (icon.png dentro il .tmod). Il frontend aggiunge all'indirizzo la data del file,
     * quindi il browser può tenerla in cache a lungo: quando la mod cambia, cambia anche l'indirizzo.
     */
    public function icon(string $server, string $mod): Response
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        return response($this->agent->stream("/servers/{$server}/mods/{$mod}/icon")->body(), 200, [
            'Content-Type' => 'image/png',
            'Cache-Control' => 'private, max-age=31536000, immutable',
            'X-Content-Type-Options' => 'nosniff',
        ]);
    }

    public function download(string $server, string $mod): StreamedResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Mods]);

        return $this->agent->download("/servers/{$server}/mods/{$mod}/download", "{$mod}.tmod");
    }
}
