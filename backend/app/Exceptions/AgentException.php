<?php

namespace App\Exceptions;

use Exception;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * Errore nella comunicazione con l'agent: agent irraggiungibile (503)
 * oppure una richiesta rifiutata dall'agent (404, 409, …) da girare al client.
 */
class AgentException extends Exception
{
    /**
     * @param  array<string, mixed>  $details  informazioni strutturate dall'agent (es. mod dipendenti)
     */
    public function __construct(
        string $message,
        public readonly int $status = 503,
        public readonly string $error = 'agent_unavailable',
        public readonly array $details = [],
    ) {
        parent::__construct($message);
    }

    public static function unreachable(): self
    {
        return new self('Agent non raggiungibile: controlla che il servizio tmodmanager-agent sia attivo.');
    }

    /**
     * @param  array{error?: string, message?: string, details?: array<string, mixed>}|null  $body
     */
    public static function fromResponse(int $status, ?array $body): self
    {
        // Un 401 dall'agent significa token sbagliato in .env: per il client è un errore del server, non suo.
        if ($status === 401 || $status >= 500) {
            return new self($body['message'] ?? 'Errore interno dell\'agent.', 502, 'agent_error');
        }

        return new self($body['message'] ?? 'Richiesta rifiutata dall\'agent.', $status, $body['error'] ?? 'agent_error', $body['details'] ?? []);
    }

    /**
     * Gli errori "previsti" (server spento, già acceso, …) non vanno nei log; quelli di comunicazione sì.
     */
    public function report(): bool
    {
        return $this->status < 500;
    }

    public function render(Request $request): JsonResponse
    {
        return response()->json(array_filter([
            'error' => $this->error,
            'message' => $this->getMessage(),
            'details' => $this->details,
        ], fn (mixed $value): bool => $value !== []), $this->status);
    }
}
