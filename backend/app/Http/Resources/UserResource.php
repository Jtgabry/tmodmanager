<?php

namespace App\Http\Resources;

use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * @mixin User
 */
class UserResource extends JsonResource
{
    /**
     * @return array{id: int, name: string, email: string, isAdmin: bool, isApproved: bool, approvedAt: ?string, createdAt: ?string, servers: array<string, list<string>>|null}
     */
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'name' => $this->name,
            'email' => $this->email,
            'isAdmin' => $this->is_admin,
            'isApproved' => $this->isApproved(),
            'approvedAt' => $this->approved_at?->toIso8601String(),
            'createdAt' => $this->created_at?->toIso8601String(),
            'servers' => $this->serverAbilityMap(),
        ];
    }
}
