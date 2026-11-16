<?php

namespace App\Models;

use App\Enums\ServerAbility;
use Database\Factories\UserFactory;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Attributes\Hidden;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;
use Laravel\Sanctum\HasApiTokens;

/**
 * is_admin e approved_at non sono fillable: si impostano solo esplicitamente (comando artisan, admin).
 */
#[Fillable(['name', 'email', 'password'])]
#[Hidden(['password', 'remember_token'])]
class User extends Authenticatable
{
    /** @use HasFactory<UserFactory> */
    use HasApiTokens, HasFactory, Notifiable;

    /**
     * Get the attributes that should be cast.
     *
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'email_verified_at' => 'datetime',
            'password' => 'hashed',
            'is_admin' => 'boolean',
            'approved_at' => 'datetime',
        ];
    }

    /**
     * @return HasMany<ServerAccess, $this>
     */
    public function serverAccesses(): HasMany
    {
        return $this->hasMany(ServerAccess::class);
    }

    public function isApproved(): bool
    {
        return $this->approved_at !== null;
    }

    public function approve(): void
    {
        $this->forceFill(['approved_at' => now()])->save();
    }

    /**
     * Permesso su un server. Gli admin passano dal Gate::before, qui si valuta solo l'accesso esplicito.
     */
    public function hasServerAbility(string $serverId, ServerAbility $ability): bool
    {
        $access = $this->serverAccesses->firstWhere('server_id', $serverId);

        return $access !== null && ($ability === ServerAbility::View || $access->abilities->contains($ability));
    }

    /**
     * Mappa server → permessi, come la vede il frontend. Null per gli admin (= tutto su tutti i server).
     *
     * @return array<string, list<string>>|null
     */
    public function serverAbilityMap(): ?array
    {
        if ($this->is_admin) {
            return null;
        }

        return $this->serverAccesses
            ->mapWithKeys(fn (ServerAccess $access): array => [$access->server_id => $access->abilityValues()])
            ->all();
    }
}
