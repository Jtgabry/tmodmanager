<?php

namespace Database\Factories;

use App\Models\WorkshopItem;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<WorkshopItem>
 */
class WorkshopItemFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'workshop_id' => (string) fake()->unique()->numberBetween(2_000_000_000, 3_999_999_999),
            'mod_name' => fake()->unique()->regexify('[A-Z][a-z]{4,10}Mod'),
            'found' => true,
            'title' => fake()->words(3, true),
            'tags' => ['Quality of Life'],
            'preview_url' => null,
            'subscriptions' => fake()->numberBetween(0, 500_000),
            'file_size' => fake()->numberBetween(10_000, 50_000_000),
            'workshop_updated_at' => now()->subDays(3),
            'fetched_at' => now(),
        ];
    }

    /**
     * Elemento rimosso o privato.
     */
    public function missing(): static
    {
        return $this->state(fn (): array => ['found' => false, 'title' => null, 'tags' => [], 'subscriptions' => null]);
    }
}
