<?php

namespace App\Http\Controllers\Api\V1\Auth;

use App\Http\Controllers\Controller;
use App\Http\Requests\Auth\LoginRequest;
use App\Http\Resources\UserResource;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Auth;

/**
 * Login/logout della SPA con sessione e cookie (Sanctum stateful).
 */
class SessionController extends Controller
{
    public function store(LoginRequest $request): UserResource|JsonResponse
    {
        abort_unless($request->hasSession(), 400, 'Il login funziona solo dalla SPA (sessione assente).');

        $request->authenticate();

        if (! $request->user()->isApproved()) {
            $this->endSession($request);

            return response()->json(['error' => 'not_approved', 'message' => 'Il tuo account è in attesa di approvazione da parte di un amministratore.'], 403);
        }

        $request->session()->regenerate();

        return new UserResource($request->user());
    }

    public function destroy(Request $request): Response
    {
        $this->endSession($request);

        return response()->noContent();
    }

    private function endSession(Request $request): void
    {
        Auth::guard('web')->logout();

        if ($request->hasSession()) {
            $request->session()->invalidate();
            $request->session()->regenerateToken();
        }
    }
}
