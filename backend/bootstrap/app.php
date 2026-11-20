<?php

use App\Http\Middleware\EnsureUserIsApproved;
use App\Http\Middleware\SetLocale;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;

$app = Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        // La SPA React si autentica con sessione e cookie (stesso dominio), non con token.
        $middleware->statefulApi();

        // Messaggi delle API nella lingua scelta nel pannello (Accept-Language)
        $middleware->api(append: [SetLocale::class]);

        // Il contenuto dei file dall'editor va salvato esattamente com'è (spazi e a capo compresi)
        $middleware->trimStrings(except: ['content']);
        $middleware->convertEmptyStringsToNull(except: [
            fn (Request $request): bool => $request->is('api/v1/servers/*/files/content'),
        ]);

        $middleware->alias([
            'approved' => EnsureUserIsApproved::class,
        ]);

        // Dietro un proxy (es. Apache davanti al container): TRUSTED_PROXIES=127.0.0.1,172.16.0.0/12 oppure *
        if ($proxies = getenv('TRUSTED_PROXIES')) {
            $middleware->trustProxies(at: $proxies === '*' ? '*' : array_map('trim', explode(',', $proxies)));
        }

        // API: un utente non autenticato riceve 401 JSON, mai un redirect.
        // Altrove: redirect alla pagina di login della SPA React.
        $middleware->redirectGuestsTo(
            fn (Request $request): ?string => $request->is('api/*') ? null : '/login',
        );
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->shouldRenderJsonWhen(
            fn (Request $request) => $request->is('api/*') || $request->expectsJson(),
        );
    })->create();

// In Docker storage/ sta nella cartella dati (persistente e scrivibile): LARAVEL_STORAGE_PATH
if ($storage = getenv('LARAVEL_STORAGE_PATH')) {
    $app->useStoragePath($storage);
}

return $app;
