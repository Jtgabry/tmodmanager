<?php

namespace App\Http\Controllers\Api\V1;

use App\Enums\ServerAbility;
use App\Http\Controllers\Controller;
use App\Services\Agent\AgentClient;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Log;

/**
 * Cestino di un server: file eliminati o sovrascritti (permesso "files") e mod e plugin eliminati (permesso "mods").
 * Gli elementi vengono cancellati dall'agent dopo 30 giorni.
 */
class ServerTrashController extends Controller
{
    public function __construct(private readonly AgentClient $agent) {}

    public function index(Request $request, string $server): JsonResponse
    {
        return response()->json(['data' => $this->agent->json('get', "/servers/{$server}/trash", ['kinds' => $this->kinds($request, $server)])]);
    }

    public function restore(Request $request, string $server, string $item): JsonResponse
    {
        // Parametri in query string: l'agent li legge da lì anche per la POST
        $query = http_build_query([
            'kinds' => $this->kinds($request, $server),
            'overwrite' => $request->boolean('overwrite') ? '1' : '0',
        ]);
        $result = $this->agent->json('post', "/servers/{$server}/trash/{$item}/restore?{$query}");

        Log::info('Ripristino dal cestino', ['user' => $request->user()->email, 'server' => $server, 'item' => $item]);

        return response()->json(['data' => $result]);
    }

    public function destroy(Request $request, string $server, string $item): Response
    {
        $this->agent->json('delete', "/servers/{$server}/trash/{$item}", ['kinds' => $this->kinds($request, $server)]);

        return response()->noContent();
    }

    public function clear(Request $request, string $server): JsonResponse
    {
        $result = $this->agent->json('delete', "/servers/{$server}/trash", ['kinds' => $this->kinds($request, $server)]);
        Log::info('Cestino svuotato', ['user' => $request->user()->email, 'server' => $server]);

        return response()->json(['data' => $result]);
    }

    /**
     * Tipi di elementi accessibili all'utente; 403 se nessuno.
     */
    private function kinds(Request $request, string $server): string
    {
        $user = $request->user();
        $kinds = array_keys(array_filter([
            'file' => $user->can('server', [$server, ServerAbility::Files]),
            'mod' => $user->can('server', [$server, ServerAbility::Mods]),
            'plugin' => $user->can('server', [$server, ServerAbility::Mods]),
        ]));
        abort_if($kinds === [], 403);

        return implode(',', $kinds);
    }
}
