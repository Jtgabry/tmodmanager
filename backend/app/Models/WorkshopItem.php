<?php

namespace App\Models;

use Database\Factories\WorkshopItemFactory;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

/**
 * Dati di una pagina dello Steam Workshop conservati nel database (vedi WorkshopCatalog).
 */
#[Fillable(['workshop_id', 'mod_name', 'found', 'title', 'tags', 'preview_url', 'subscriptions', 'file_size', 'workshop_updated_at', 'fetched_at'])]
class WorkshopItem extends Model
{
    /** @use HasFactory<WorkshopItemFactory> */
    use HasFactory;

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'found' => 'boolean',
            'tags' => 'array',
            'subscriptions' => 'integer',
            'file_size' => 'integer',
            'workshop_updated_at' => 'datetime',
            'fetched_at' => 'datetime',
        ];
    }

    /**
     * Quello che serve alla pagina delle mod.
     *
     * @return array{id: string, title: string|null, tags: list<string>, previewUrl: string|null, subscriptions: int|null, updatedAt: string|null}
     */
    public function summary(): array
    {
        return [
            'id' => $this->workshop_id,
            'title' => $this->title,
            'tags' => $this->tags,
            'previewUrl' => $this->preview_url,
            'subscriptions' => $this->subscriptions,
            'updatedAt' => $this->workshop_updated_at?->toIso8601String(),
        ];
    }
}
