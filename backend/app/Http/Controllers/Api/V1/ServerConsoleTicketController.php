<?php

namespace App\Http\Controllers\Api\V1;

use App\Enums\ServerAbility;
use App\Http\Controllers\Controller;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;

/**
 * Ticket per aprire la console in tempo reale (WebSocket servito dall'agent, raggiunto tramite Apache su /ws/).
 * Il ticket è firmato con il token condiviso con l'agent, vale per un solo server e scade dopo 30 secondi:
 * serve solo ad aprire la connessione.
 */
class ServerConsoleTicketController extends Controller
{
    private const TTL_SECONDS = 30;

    public function __invoke(Request $request, string $server): JsonResponse
    {
        Gate::authorize('server', [$server, ServerAbility::Console]);

        $body = self::base64Url((string) json_encode([
            's' => $server,
            'u' => $request->user()->id,
            'e' => now()->addSeconds(self::TTL_SECONDS)->getTimestamp(),
        ]));
        $signature = self::base64Url(hash_hmac('sha256', "ws-ticket.{$body}", (string) config('services.agent.token'), true));
        $ticket = "{$body}.{$signature}";

        return response()->json(['data' => [
            'path' => "/ws/servers/{$server}/console?ticket={$ticket}",
            'expiresIn' => self::TTL_SECONDS,
        ]]);
    }

    private static function base64Url(string $value): string
    {
        return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
    }
}
