<?php

namespace App\Http\Resources;

use App\Models\Invitation;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * @mixin Invitation
 */
class InvitationResource extends JsonResource
{
    /**
     * Il link completo (con il token in chiaro) c'è solo nella risposta di creazione.
     *
     * @return array<string, mixed>
     */
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'email' => $this->email,
            'createdBy' => $this->creator?->name,
            'usedBy' => $this->usedBy?->name,
            'expiresAt' => $this->expires_at->toIso8601String(),
            'usedAt' => $this->used_at?->toIso8601String(),
            'status' => match (true) {
                $this->used_at !== null => 'used',
                $this->expires_at->isPast() => 'expired',
                default => 'active',
            },
            'createdAt' => $this->created_at?->toIso8601String(),
        ];
    }
}
