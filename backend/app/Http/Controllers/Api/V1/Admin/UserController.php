<?php

namespace App\Http\Controllers\Api\V1\Admin;

use App\Http\Controllers\Controller;
use App\Http\Requests\Admin\UpdateUserRequest;
use App\Http\Resources\UserResource;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\AnonymousResourceCollection;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\DB;

class UserController extends Controller
{
    /**
     * Utenti in attesa prima, poi in ordine di nome.
     */
    public function index(): AnonymousResourceCollection
    {
        $users = User::query()
            ->with('serverAccesses')
            ->orderByRaw('approved_at is not null')
            ->orderBy('name')
            ->get();

        return UserResource::collection($users);
    }

    public function update(UpdateUserRequest $request, User $user): UserResource
    {
        $data = $request->validated();

        $user->forceFill([
            'is_admin' => $data['isAdmin'] ?? $user->is_admin,
            'approved_at' => array_key_exists('isApproved', $data)
                ? ($data['isApproved'] ? ($user->approved_at ?? now()) : null)
                : $user->approved_at,
        ])->save();

        if ($user->wasChanged('approved_at') && $user->approved_at === null) {
            $this->logoutEverywhere($user);
        }

        return new UserResource($user->load('serverAccesses'));
    }

    public function destroy(Request $request, User $user): Response|JsonResponse
    {
        if ($user->is($request->user())) {
            return response()->json(['error' => 'forbidden', 'message' => 'Non puoi eliminare il tuo account.'], 422);
        }

        $this->logoutEverywhere($user);
        $user->delete();

        return response()->noContent();
    }

    /**
     * Le sessioni sono nel database: eliminarle chiude subito l'accesso dell'utente.
     */
    private function logoutEverywhere(User $user): void
    {
        DB::table('sessions')->where('user_id', $user->id)->delete();
        $user->tokens()->delete();
    }
}
