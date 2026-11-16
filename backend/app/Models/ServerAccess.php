<?php

namespace App\Models;

use App\Enums\ServerAbility;
use Database\Factories\ServerAccessFactory;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Casts\AsEnumCollection;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Collection;

/**
 * Accesso di un utente a un server dell'agent, con i permessi concessi.
 *
 * @property Collection<int, ServerAbility> $abilities
 */
#[Fillable(['user_id', 'server_id', 'abilities'])]
class ServerAccess extends Model
{
    /** @use HasFactory<ServerAccessFactory> */
    use HasFactory;

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'abilities' => AsEnumCollection::of(ServerAbility::class),
        ];
    }

    /**
     * @return BelongsTo<User, $this>
     */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    /**
     * Permessi come stringhe, "view" sempre incluso.
     *
     * @return list<string>
     */
    public function abilityValues(): array
    {
        return $this->abilities
            ->push(ServerAbility::View)
            ->unique()
            ->map(fn (ServerAbility $ability): string => $ability->value)
            ->values()
            ->all();
    }
}
