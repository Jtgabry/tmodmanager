<?php

namespace App\Services\Workshop;

use App\Exceptions\AgentException;
use App\Models\WorkshopItem;
use App\Services\Agent\AgentClient;
use Illuminate\Database\Eloquent\Collection;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Log;

/**
 * Dati delle pagine dello Steam Workshop conservati nel database, come una cache:
 * ogni volta che l'agent li riceve da Steam (controllo aggiornamenti, ricerca, collegamento)
 * vengono salvati o aggiornati, e le pagine del sito li leggono da qui senza interrogare Steam.
 * Se per qualche mod mancano, si chiedono all'agent tutti insieme con una sola richiesta.
 */
class WorkshopCatalog
{
    public function __construct(private readonly AgentClient $agent) {}

    /**
     * Salva (o aggiorna) gli elementi arrivati dall'agent.
     *
     * @param  iterable<array<string, mixed>>  $items  WorkshopItem dell'agent
     */
    public function remember(iterable $items): void
    {
        $now = now();
        $rows = [];

        foreach ($items as $item) {
            $id = (string) ($item['id'] ?? '');
            if (! preg_match('/^\d{1,20}$/', $id)) {
                continue;
            }

            $rows[$id] = [
                'workshop_id' => $id,
                'mod_name' => $item['modName'] ?? null,
                'found' => (bool) ($item['found'] ?? false),
                'title' => isset($item['title']) ? mb_substr((string) $item['title'], 0, 255) : null,
                'tags' => json_encode(array_values(array_filter($item['tags'] ?? [], 'is_string'))),
                'preview_url' => isset($item['previewUrl']) ? mb_substr((string) $item['previewUrl'], 0, 1000) : null,
                'subscriptions' => isset($item['subscriptions']) ? (int) $item['subscriptions'] : null,
                'file_size' => isset($item['fileSize']) ? (int) $item['fileSize'] : null,
                'workshop_updated_at' => isset($item['timeUpdated']) ? Carbon::parse($item['timeUpdated']) : null,
                'fetched_at' => $now,
                'created_at' => $now,
                'updated_at' => $now,
            ];
        }

        if ($rows === []) {
            return;
        }

        WorkshopItem::upsert(
            array_values($rows),
            ['workshop_id'],
            ['mod_name', 'found', 'title', 'tags', 'preview_url', 'subscriptions', 'file_size', 'workshop_updated_at', 'fetched_at', 'updated_at'],
        );
    }

    /**
     * Dati degli elementi indicati. Quelli mai visti si chiedono all'agent in un colpo solo;
     * se Steam o l'agent non rispondono si restituisce quello che c'è già.
     *
     * @param  list<string>  $ids
     * @return Collection<string, WorkshopItem> per workshop_id
     */
    public function forIds(array $ids): Collection
    {
        $ids = array_values(array_unique(array_filter($ids, fn ($id): bool => is_string($id) && preg_match('/^\d{1,20}$/', $id) === 1)));
        if ($ids === []) {
            return new Collection;
        }

        $known = WorkshopItem::whereIn('workshop_id', $ids)->get()->keyBy('workshop_id');
        $missing = array_values(array_diff($ids, $known->keys()->all()));

        if ($missing !== []) {
            try {
                $this->remember($this->agent->json('post', '/workshop/details', ['ids' => $missing], timeout: 30) ?? []);
                $known = WorkshopItem::whereIn('workshop_id', $ids)->get()->keyBy('workshop_id');
            } catch (AgentException $exception) {
                Log::warning('Dati del Workshop non disponibili', ['ids' => $missing, 'error' => $exception->getMessage()]);
            }
        }

        return $known;
    }
}
