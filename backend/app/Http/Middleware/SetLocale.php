<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\App;
use Symfony\Component\HttpFoundation\Response;

/**
 * Lingua dei messaggi delle API (errori, validazione): quella scelta nel pannello, che la SPA manda
 * in Accept-Language. Senza preferenza, o con una lingua non supportata, resta l'inglese.
 */
class SetLocale
{
    /** @var list<string> */
    public const SUPPORTED = ['en', 'it'];

    public function handle(Request $request, Closure $next): Response
    {
        if ($request->headers->has('Accept-Language')) {
            App::setLocale($request->getPreferredLanguage(self::SUPPORTED) ?? 'en');
        }

        return $next($request);
    }
}
