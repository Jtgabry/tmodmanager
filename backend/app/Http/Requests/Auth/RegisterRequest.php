<?php

namespace App\Http\Requests\Auth;

use App\Models\Invitation;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rules\Password;
use Illuminate\Validation\Validator;

class RegisterRequest extends FormRequest
{
    private ?Invitation $invitation = null;

    /**
     * @return array<string, array<int, mixed>>
     */
    public function rules(): array
    {
        return [
            'name' => ['required', 'string', 'max:255'],
            'email' => ['required', 'string', 'lowercase', 'email', 'max:255', 'unique:users,email'],
            'password' => ['required', 'confirmed', Password::defaults()],
            'invitation' => ['nullable', 'string'],
        ];
    }

    /**
     * @return array<int, callable(Validator): void>
     */
    public function after(): array
    {
        return [
            function (Validator $validator): void {
                $token = $this->input('invitation');
                if (! $token) {
                    return;
                }

                $this->invitation = Invitation::findUsable($token);

                if (! $this->invitation) {
                    $validator->errors()->add('invitation', 'Invito non valido, già usato o scaduto.');
                } elseif (! $this->invitation->allowsEmail((string) $this->input('email'))) {
                    $validator->errors()->add('email', 'Questo invito è riservato a un altro indirizzo email.');
                }
            },
        ];
    }

    public function invitation(): ?Invitation
    {
        return $this->invitation;
    }
}
