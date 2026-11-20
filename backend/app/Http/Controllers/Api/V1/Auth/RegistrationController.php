<?php

namespace App\Http\Controllers\Api\V1\Auth;

use App\Http\Controllers\Controller;
use App\Http\Requests\Auth\RegisterRequest;
use App\Http\Resources\UserResource;
use App\Models\User;
use App\Support\InitialSetup;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;

/**
 * Registrazione: con un invito valido l'account è attivo subito, altrimenti resta in attesa di un admin.
 */
class RegistrationController extends Controller
{
    public function store(RegisterRequest $request): JsonResponse
    {
        abort_unless($request->hasSession(), 400, __('Login only works from the web app (no session).'));
        abort_if(InitialSetup::required(), 409, __('The site is not set up yet: the administrator must be created first.'));

        $invitation = $request->invitation();

        $user = DB::transaction(function () use ($request, $invitation): User {
            $user = User::create($request->safe()->only(['name', 'email', 'password']));

            if ($invitation) {
                $user->approve();
                $invitation->markUsedBy($user);
            }

            return $user;
        });

        if (! $user->isApproved()) {
            return response()->json(['status' => 'pending'], 201);
        }

        Auth::login($user);
        $request->session()->regenerate();

        return response()->json(['status' => 'active', 'user' => new UserResource($user)], 201);
    }
}
