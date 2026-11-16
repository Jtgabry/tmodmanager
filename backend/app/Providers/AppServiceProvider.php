<?php

namespace App\Providers;

use App\Enums\ServerAbility;
use App\Models\User;
use App\Services\Agent\AgentClient;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        $this->app->singleton(AgentClient::class, fn (): AgentClient => new AgentClient(
            baseUrl: config('services.agent.url'),
            token: config('services.agent.token'),
        ));
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        Gate::before(fn (User $user): ?bool => $user->is_admin ? true : null);

        Gate::define('admin', fn (User $user): bool => $user->is_admin);

        Gate::define('server', fn (User $user, string $serverId, ServerAbility $ability): bool => $user->hasServerAbility($serverId, $ability));
    }
}
