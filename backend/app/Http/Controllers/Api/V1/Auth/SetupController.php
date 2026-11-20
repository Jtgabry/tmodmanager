<?php

namespace App\Http\Controllers\Api\V1\Auth;

use App\Http\Controllers\Controller;
use App\Http\Requests\Auth\SetupRequest;
use App\Http\Resources\UserResource;
use App\Models\User;
use App\Support\InitialSetup;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Cache;
use Illuminate\Validation\ValidationException;

/**
 * Primo avvio: creazione dell'amministratore dal browser (vedi InitialSetup).
 */
class SetupController extends Controller
{
    public function show(): JsonResponse
    {
        return response()->json(['data' => ['required' => InitialSetup::required()]]);
    }

    public function store(SetupRequest $request): JsonResponse
    {
        abort_unless($request->hasSession(), 400, __('Login only works from the web app (no session).'));

        // Un solo tentativo alla volta: due richieste insieme non devono creare due amministratori
        $user = Cache::lock('initial-setup', 10)->block(5, function () use ($request): User {
            abort_unless(InitialSetup::required(), 409, __('The initial setup has already been completed.'));

            if (! InitialSetup::verify($request->validated('code'))) {
                throw ValidationException::withMessages(['code' => __('Invalid code. The "php artisan setup:code" command shows it.')]);
            }

            $user = new User($request->safe()->only(['name', 'email', 'password']));
            $user->forceFill(['is_admin' => true, 'approved_at' => now()])->save();
            InitialSetup::forget();

            return $user;
        });

        Auth::login($user, remember: true);
        $request->session()->regenerate();

        return response()->json(['data' => new UserResource($user)], 201);
    }
}
