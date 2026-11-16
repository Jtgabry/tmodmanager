<?php

namespace Database\Factories;

use App\Models\Invitation;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Str;

/**
 * @extends Factory<Invitation>
 */
class InvitationFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'token_hash' => Invitation::hashToken(Str::random(48)),
            'email' => null,
            'created_by' => User::factory()->admin(),
            'expires_at' => now()->addDays(7),
        ];
    }

    /**
     * Invito con un token noto, per poterlo usare nei test.
     */
    public function withToken(string $token): static
    {
        return $this->state(fn (): array => ['token_hash' => Invitation::hashToken($token)]);
    }

    public function expired(): static
    {
        return $this->state(fn (): array => ['expires_at' => now()->subMinute()]);
    }

    public function used(): static
    {
        return $this->state(fn (): array => ['used_at' => now()->subHour()]);
    }
}
