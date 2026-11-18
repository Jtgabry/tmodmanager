<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * Stato di un server come restituito dall'agent (array, non un modello Eloquent).
 *
 * @property-read array<string, mixed> $resource
 */
class ServerResource extends JsonResource
{
    /**
     * @return array{
     *     id: string, name: string, state: string, operation: ?string, managed: bool,
     *     pid: ?int, subworlds: int, uptimeSeconds: ?int, cpuPercent: ?float, memoryBytes: ?int,
     *     players: array{online: int, max: int}, world: ?string, port: int, hasPassword: bool,
     *     game: string, version: ?string, tmlVersion: ?string, restartRequired: bool, lastError: ?array{operation: string, message: string, at: string}
     * }
     */
    public function toArray(Request $request): array
    {
        $server = $this->resource;

        return [
            'id' => $server['id'],
            'name' => $server['name'],
            'state' => $server['state'],
            'operation' => $server['operation'],
            'managed' => $server['managed'],
            'pid' => $server['pid'],
            'subworlds' => $server['subworlds'],
            'uptimeSeconds' => $server['uptimeSeconds'],
            'cpuPercent' => $server['cpuPercent'],
            'memoryBytes' => $server['memoryBytes'],
            'players' => $server['players'],
            'world' => $server['world'],
            'port' => $server['port'],
            'hasPassword' => $server['hasPassword'],
            // Server registrati prima del vanilla (o agent non aggiornato): tModLoader
            'game' => $server['game'] ?? 'tmodloader',
            'version' => $server['version'] ?? $server['tmlVersion'],
            // Versione di Terraria (per TShock e tModLoader: quella su cui si basano)
            'gameVersion' => $server['gameVersion'] ?? null,
            'tmlVersion' => $server['tmlVersion'],
            'restartRequired' => $server['restartRequired'] ?? false,
            'lastError' => $server['lastError'],
        ];
    }
}
