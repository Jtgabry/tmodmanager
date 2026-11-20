<?php

namespace App\Services\Agent;

use App\Exceptions\AgentException;
use GuzzleHttp\Psr7\Utils;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\App;
use Illuminate\Support\Facades\Http;
use Symfony\Component\HttpFoundation\HeaderUtils;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * Client HTTP verso l'agent (demone Node che gestisce processi e file dei server).
 * Laravel non tocca mai direttamente processi o file dei server: passa sempre da qui.
 */
class AgentClient
{
    public function __construct(
        private readonly string $baseUrl,
        private readonly ?string $token,
    ) {}

    /**
     * @return list<array<string, mixed>>
     */
    public function servers(): array
    {
        return $this->send(fn (PendingRequest $http) => $http->get('/servers'))['data'];
    }

    /**
     * @return array<string, mixed>
     */
    public function server(string $id): array
    {
        return $this->send(fn (PendingRequest $http) => $http->get("/servers/{$id}"))['data'];
    }

    /**
     * Avvia un'operazione (start, stop, restart). L'agent risponde subito (202) e la porta avanti in background.
     *
     * @return array<string, mixed>
     */
    public function power(string $id, ServerPowerAction $action): array
    {
        return $this->send(fn (PendingRequest $http) => $http->post("/servers/{$id}/{$action->value}"))['data'];
    }

    /**
     * Output della console dalla posizione `offset` (byte); senza offset, la coda del log.
     *
     * @return array{offset: int, data: string, reset: bool}
     */
    public function console(string $id, ?int $offset = null): array
    {
        return $this->send(fn (PendingRequest $http) => $http->get("/servers/{$id}/console", array_filter(['offset' => $offset], fn ($value) => $value !== null)))['data'];
    }

    public function sendCommand(string $id, string $command): void
    {
        $this->send(fn (PendingRequest $http) => $http->post("/servers/{$id}/console", ['command' => $command]));
    }

    /**
     * Richiesta JSON generica verso l'agent; restituisce il campo "data" della risposta.
     *
     * @param  'get'|'post'|'put'|'patch'|'delete'  $method
     * @param  array<string, mixed>  $payload  query string per GET/DELETE, corpo JSON per gli altri
     * @param  int  $timeout  secondi (alcune operazioni, come copiare le mod di un server, sono lente)
     */
    public function json(string $method, string $path, array $payload = [], int $timeout = 10): mixed
    {
        return $this->send(fn (PendingRequest $http) => match ($method) {
            'get' => $http->get($path, $payload),
            // Il client HTTP mette i dati di DELETE nel corpo: l'agent li legge dalla query string
            'delete' => $http->delete($payload === [] ? $path : $path.'?'.http_build_query($payload)),
            default => $http->{$method}($path, $payload === [] ? (object) [] : $payload),
        }, $timeout)['data'] ?? null;
    }

    /**
     * Invia un file locale in streaming (PUT, application/octet-stream): non passa dalla memoria.
     *
     * @param  array<string, scalar>  $query
     */
    public function upload(string $path, string $localFile, array $query = []): mixed
    {
        $url = $query === [] ? $path : $path.'?'.http_build_query($query);

        return $this->send(
            fn (PendingRequest $http) => $http->withBody(Utils::streamFor(fopen($localFile, 'rb')), 'application/octet-stream')->put($url),
            timeout: 600,
        )['data'] ?? null;
    }

    /**
     * Risposta in streaming (download): il chiamante legge il corpo a blocchi.
     *
     * @param  array<string, scalar>  $query
     */
    public function stream(string $path, array $query = []): Response
    {
        try {
            $response = $this->http(timeout: 600)->withOptions(['stream' => true])->get($path, $query);
        } catch (ConnectionException) {
            throw AgentException::unreachable();
        }

        if ($response->failed()) {
            throw AgentException::fromResponse($response->status(), json_decode((string) $response->body(), true));
        }

        return $response;
    }

    /**
     * Download dall'agent girato al browser a blocchi da 1 MB, senza caricarlo in memoria.
     *
     * @param  array<string, scalar>  $query
     */
    public function download(string $path, ?string $filename = null, array $query = []): StreamedResponse
    {
        $response = $this->stream($path, $query);
        $body = $response->toPsrResponse()->getBody();
        $size = $body->getSize() ?? ($response->header('Content-Length') !== '' ? (int) $response->header('Content-Length') : null);

        return new StreamedResponse(function () use ($body): void {
            while (! $body->eof()) {
                echo $body->read(1024 * 1024);
                flush();
            }
        }, 200, array_filter([
            'Content-Type' => 'application/octet-stream',
            'Content-Length' => $size,
            // Senza nome esplicito si usa quello deciso dall'agent (es. "Cartella.tar.gz")
            'Content-Disposition' => $filename === null
                ? ($response->header('Content-Disposition') ?: 'attachment')
                : HeaderUtils::makeDisposition(HeaderUtils::DISPOSITION_ATTACHMENT, $filename, preg_replace('/[^\x20-\x7e]/', '_', $filename) ?: 'download'),
            'X-Accel-Buffering' => 'no',
        ], fn (mixed $value): bool => $value !== null));
    }

    private function http(int $timeout = 10): PendingRequest
    {
        // I messaggi dell'agent (errori, avanzamento dei lavori) arrivano nella lingua della richiesta
        return Http::baseUrl($this->baseUrl)
            ->withToken((string) $this->token)
            ->withHeaders(['Accept-Language' => App::getLocale()])
            ->acceptJson()
            ->connectTimeout(2)
            ->timeout($timeout);
    }

    /**
     * @param  callable(PendingRequest): Response  $request
     * @return array<string, mixed>
     */
    private function send(callable $request, int $timeout = 10): array
    {
        try {
            $response = $request($this->http($timeout));
        } catch (ConnectionException) {
            throw AgentException::unreachable();
        }

        if ($response->failed()) {
            throw AgentException::fromResponse($response->status(), $response->json());
        }

        return $response->json() ?? [];
    }
}
