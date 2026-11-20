<?php

namespace App\Http\Requests\Admin;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Validator;

class UpdateUserRequest extends FormRequest
{
    /**
     * @return array<string, array<int, string>>
     */
    public function rules(): array
    {
        return [
            'isAdmin' => ['sometimes', 'boolean'],
            'isApproved' => ['sometimes', 'boolean'],
        ];
    }

    /**
     * Un admin non può togliersi da solo i privilegi o l'approvazione (resterebbe chiuso fuori).
     *
     * @return array<int, callable(Validator): void>
     */
    public function after(): array
    {
        return [
            function (Validator $validator): void {
                if ($this->route('user')->is($this->user())
                    && ($this->input('isAdmin') === false || $this->input('isApproved') === false)) {
                    $validator->errors()->add('isAdmin', __('You cannot remove your own privileges or approval.'));
                }
            },
        ];
    }
}
