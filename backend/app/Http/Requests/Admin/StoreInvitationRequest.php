<?php

namespace App\Http\Requests\Admin;

use Illuminate\Foundation\Http\FormRequest;

class StoreInvitationRequest extends FormRequest
{
    /**
     * @return array<string, array<int, string>>
     */
    public function rules(): array
    {
        return [
            'email' => ['nullable', 'email', 'max:255', 'unique:users,email'],
            'expiresInDays' => ['sometimes', 'integer', 'min:1', 'max:30'],
        ];
    }
}
