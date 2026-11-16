<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Blocca gli utenti non (più) approvati anche se hanno una sessione aperta.
 */
class EnsureUserIsApproved
{
    public function handle(Request $request, Closure $next): Response
    {
        if (! $request->user()?->isApproved()) {
            return response()->json(['error' => 'not_approved', 'message' => 'Account in attesa di approvazione.'], 403);
        }

        return $next($request);
    }
}
