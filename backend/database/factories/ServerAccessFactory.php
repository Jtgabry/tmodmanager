<?php

namespace Database\Factories;

use App\Enums\ServerAbility;
use App\Models\ServerAccess;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<ServerAccess>
 */
class ServerAccessFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'user_id' => User::factory(),
            'server_id' => 'alfa',
            'abilities' => [],
        ];
    }

    /**
     * @param  list<ServerAbility>  $abilities
     */
    public function abilities(array $abilities): static
    {
        return $this->state(fn (): array => ['abilities' => $abilities]);
    }
}
