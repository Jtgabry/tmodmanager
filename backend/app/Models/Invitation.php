<?php

namespace App\Models;

use Database\Factories\InvitationFactory;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;
use Illuminate\Support\Str;

/**
 * Invito alla registrazione: monouso, con scadenza, opzionalmente legato a un'email.
 * Nel database c'è solo l'hash del token.
 */
#[Fillable(['token_hash', 'email', 'created_by', 'expires_at'])]
class Invitation extends Model
{
    /** @use HasFactory<InvitationFactory> */
    use HasFactory;

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'expires_at' => 'datetime',
            'used_at' => 'datetime',
        ];
    }

    /**
     * Crea un invito e restituisce anche il token in chiaro, che non sarà più recuperabile.
     *
     * @return array{invitation: self, token: string}
     */
    public static function issue(User $creator, ?string $email, Carbon $expiresAt): array
    {
        $token = Str::random(48);

        $invitation = self::create([
            'token_hash' => self::hashToken($token),
            'email' => $email,
            'created_by' => $creator->id,
            'expires_at' => $expiresAt,
        ]);

        return ['invitation' => $invitation, 'token' => $token];
    }

    public static function hashToken(string $token): string
    {
        return hash('sha256', $token);
    }

    public static function findUsable(string $token): ?self
    {
        return self::query()->usable()->where('token_hash', self::hashToken($token))->first();
    }

    /**
     * @param  Builder<self>  $query
     */
    public function scopeUsable(Builder $query): void
    {
        $query->whereNull('used_at')->where('expires_at', '>', now());
    }

    public function allowsEmail(string $email): bool
    {
        return $this->email === null || strcasecmp($this->email, $email) === 0;
    }

    public function markUsedBy(User $user): void
    {
        $this->forceFill(['used_at' => now(), 'used_by' => $user->id])->save();
    }

    /**
     * @return BelongsTo<User, $this>
     */
    public function creator(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }

    /**
     * @return BelongsTo<User, $this>
     */
    public function usedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'used_by');
    }
}
